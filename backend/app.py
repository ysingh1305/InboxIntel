from flask import Flask, request, jsonify, redirect, session, send_from_directory
from flask_cors import CORS
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from pymongo import MongoClient
import boto3
from botocore.config import Config
import os
import json
from datetime import datetime, timedelta
from dotenv import load_dotenv
import secrets

load_dotenv()

app = Flask(__name__, static_folder='../frontend')
app.secret_key = os.getenv('SECRET_KEY', secrets.token_hex(32))

# Session configuration for local development
app.config['SESSION_COOKIE_SAMESITE'] = None
app.config['SESSION_COOKIE_SECURE'] = False
app.config['SESSION_COOKIE_HTTPONLY'] = False
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=1)

CORS(
    app,
    supports_credentials=True,
    origins=['http://localhost:5000'],
    allow_headers=['Content-Type'],
    expose_headers=['Set-Cookie']
)

# MongoDB setup
mongo_client = MongoClient(os.getenv('MONGODB_URI'))
db = mongo_client['email_reports']
users_collection = db['users']
reports_collection = db['reports']
oauth_states_collection = db['oauth_states']

# AWS Lambda client (with retries + read timeout)
lambda_client = boto3.client(
    'lambda',
    region_name=os.getenv('AWS_REGION', 'us-east-1'),
    config=Config(read_timeout=60, retries={'max_attempts': 3})
)

# Gmail API setup
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']
CLIENT_SECRETS_FILE = 'credentials.json'

# Disable HTTPS requirement for local development
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'


@app.route('/')
def index():
    return send_from_directory('../frontend', 'index.html')


@app.route('/api/auth/login')
def login():
    """Initiate Gmail OAuth flow"""
    try:
        flow = Flow.from_client_secrets_file(
            CLIENT_SECRETS_FILE,
            scopes=SCOPES,
            redirect_uri='http://localhost:5000/oauth2callback'
        )
        authorization_url, state = flow.authorization_url(
            access_type='offline',
            include_granted_scopes='true',
            prompt='consent'
        )

        # Store state in MongoDB instead of session
        oauth_states_collection.insert_one({
            'state': state,
            'created_at': datetime.utcnow(),
            'expires_at': datetime.utcnow() + timedelta(minutes=10)
        })

        print(f"✓ Storing state in MongoDB: {state}")
        return jsonify({'auth_url': authorization_url})
    except Exception as e:
        print(f"✗ Login error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/oauth2callback')
def oauth2callback():
    """Handle OAuth callback"""
    try:
        url_state = request.args.get('state')
        print(f"✓ Received state from URL: {url_state}")

        if not url_state:
            return jsonify({'error': 'No state parameter received'}), 400

        # Look up state in MongoDB
        state_doc = oauth_states_collection.find_one({
            'state': url_state,
            'expires_at': {'$gt': datetime.utcnow()}
        })

        if not state_doc:
            print("✗ State not found or expired in MongoDB")
            return jsonify({'error': 'Invalid or expired state. Please try logging in again.'}), 400

        print("✓ Found valid state in MongoDB")

        # Delete the used state
        oauth_states_collection.delete_one({'_id': state_doc['_id']})

        flow = Flow.from_client_secrets_file(
            CLIENT_SECRETS_FILE,
            scopes=SCOPES,
            state=url_state,
            redirect_uri='http://localhost:5000/oauth2callback'
        )

        # Fetch token
        flow.fetch_token(authorization_response=request.url)
        credentials = flow.credentials

        # Get user email
        service = build('gmail', 'v1', credentials=credentials)
        profile = service.users().getProfile(userId='me').execute()
        user_email = profile['emailAddress']

        print(f"✓ Successfully authenticated: {user_email}")

        # Store credentials in MongoDB
        user_data = {
            'email': user_email,
            'credentials': {
                'token': credentials.token,
                'refresh_token': credentials.refresh_token,
                'token_uri': credentials.token_uri,
                'client_id': credentials.client_id,
                'client_secret': credentials.client_secret,
                'scopes': credentials.scopes
            },
            'created_at': datetime.utcnow(),
            'last_sync': None
        }

        users_collection.update_one(
            {'email': user_email},
            {'$set': user_data},
            upsert=True
        )

        session['user_email'] = user_email

        return redirect('/?status=success')

    except Exception as e:
        print(f"✗ OAuth callback error: {e}")
        return jsonify({'error': f'Authentication failed: {str(e)}'}), 500


@app.route('/api/user/status')
def user_status():
    """Check if user is authenticated"""
    user_email = session.get('user_email')
    if not user_email:
        return jsonify({'authenticated': False})

    user = users_collection.find_one({'email': user_email})
    if not user:
        return jsonify({'authenticated': False})

    return jsonify({
        'authenticated': True,
        'email': user_email,
        'last_sync': user.get('last_sync').isoformat() if user.get('last_sync') else None
    })


@app.route('/api/generate-report', methods=['POST'])
def generate_report():
    """
    Always return a stable JSON shape:
    { "success": true|false, "report": {...}|None, "error": {...}|None }
    """

    def try_json(x):
        """Safely parse a stringified JSON body coming back from Lambda."""
        if isinstance(x, (bytes, bytearray)):
            try:
                x = x.decode('utf-8')
            except Exception:
                return x
        if isinstance(x, str):
            s = x.strip()
            if s.startswith('{') or s.startswith('['):
                try:
                    return json.loads(s)
                except Exception:
                    return x
        return x

    user_email = session.get('user_email')
    if not user_email:
        return jsonify({'success': False, 'report': None, 'error': {'type': 'Auth', 'details': 'Not authenticated'}}), 200

    data = request.json or {}
    days = data.get('days', 7)

    user = users_collection.find_one({'email': user_email})
    if not user:
        return jsonify({'success': False, 'report': None, 'error': {'type': 'NotFound', 'details': 'User not found'}}), 200

    payload = {
        'user_email': user_email,
        'credentials': user['credentials'],
        'days': days
    }

    try:
        response = lambda_client.invoke(
            FunctionName=os.getenv('LAMBDA_FUNCTION_NAME'),
            InvocationType='RequestResponse',
            Payload=json.dumps(payload)
        )

        # If Lambda itself threw a runtime error
        if response.get('FunctionError'):
            raw_err = response['Payload'].read() or b'{}'
            err_payload = try_json(json.loads(raw_err))
            return jsonify({
                'success': False,
                'report': None,
                'error': {'type': 'LambdaFunctionError', 'details': err_payload}
            }), 200

        # Normal path
        raw = response['Payload'].read() or b'{}'
        parsed = json.loads(raw)
        status_code = parsed.get('statusCode', 200)

        # Body can be an object OR a stringified JSON. Normalize it.
        result_body = try_json(parsed.get('body', parsed))

        if status_code != 200:
            result_body = try_json(result_body)
            return jsonify({
                'success': False,
                'report': None,
                'error': {'type': 'ReportGenerationFailed', 'details': result_body}
            }), 200

        # Defensive: ensure we return an object as report
        if isinstance(result_body, str):
            result_body = {'summary': result_body}

        # Store report
        report_data = {
            'user_email': user_email,
            'report': result_body,
            'days': days,
            'created_at': datetime.utcnow()
        }
        report_id = reports_collection.insert_one(report_data).inserted_id

        users_collection.update_one({'email': user_email}, {'$set': {'last_sync': datetime.utcnow()}})

        return jsonify({'success': True, 'report_id': str(report_id), 'report': result_body, 'error': None}), 200

    except Exception as e:
        print(f"Report generation error: {e}")
        return jsonify({'success': False, 'report': None, 'error': {'type': 'Server', 'details': str(e)}}), 200


@app.route('/api/reports')
def get_reports():
    user_email = session.get('user_email')
    if not user_email:
        return jsonify({'error': 'Not authenticated'}), 401

    reports = list(reports_collection.find({'user_email': user_email}).sort('created_at', -1).limit(10))
    for report in reports:
        report['_id'] = str(report['_id'])
        report['created_at'] = report['created_at'].isoformat()

    return jsonify({'reports': reports})


@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'message': 'Logged out successfully'})


if __name__ == '__main__':
    app.run(debug=True, port=5000)
