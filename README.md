# InboxIntel

InboxIntel is an AI-powered email insight generator that connects to your Gmail, processes recent emails, and generates an executive summary with key topics, action items, and sentiment analysis.

## Features
- Secure Gmail OAuth authentication
- AI-powered summaries using OpenAI
- Adjustable analysis period (1, 3, 7, 14, or 30 days)
- Serverless backend with AWS Lambda
- S3 integration for storing generated reports
- MongoDB database for user and session management
- Clean frontend dashboard for easy report generation and visualization

## Tech Stack
- Frontend: HTML, CSS, JavaScript
- Backend: Python (Flask), MongoDB
- Email Processing: Node.js (AWS Lambda)
- AI: OpenAI GPT-4o / GPT-4o-mini
- Storage: AWS S3
- Authentication: Gmail API (OAuth 2.0)

## How It Works
1. User connects their Gmail account via OAuth.
2. The backend triggers the AWS Lambda function with user credentials.
3. Lambda fetches recent emails using the Gmail API.
4. OpenAI analyzes the email snippets and produces a structured JSON summary.
5. Reports are stored in Amazon S3, and metadata is logged in MongoDB.
6. The frontend retrieves and displays the report.
