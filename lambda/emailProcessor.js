
const { google } = require('googleapis');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const OpenAI = require('openai');

const REGION = process.env.AWS_REGION || 'us-east-1';
const s3Client = new S3Client({ region: REGION });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


const MODEL_ID = 'gpt-4o-mini'; // or 'gpt-4o' for higher quality
const MAX_INPUT_TOKENS_BUDGET = Number(process.env.MAX_INPUT_TOKENS_BUDGET || 7000);
const PER_EMAIL_SNIPPET_LIMIT = 220;
const MAX_EMAILS_FOR_MODEL = 40;

function pick(headers, name) {
  const h = headers?.find(x => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function stripHtml(html) {
  return html
    .replace(/<\/(p|div|br|li|h\d)>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeBody(payload) {
  const walk = (part) => {
    if (!part) return '';
    if (part.body?.data) {
      const buf = Buffer.from(part.body.data, 'base64');
      const text = buf.toString('utf-8');
      if (part.mimeType?.includes('html')) return stripHtml(text);
      return text;
    }
    if (Array.isArray(part.parts)) {
      const plain = part.parts.find(p => p.mimeType === 'text/plain');
      if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64').toString('utf-8');
      const html = part.parts.find(p => (p.mimeType || '').includes('html'));
      if (html?.body?.data) return stripHtml(Buffer.from(html.body.data, 'base64').toString('utf-8'));
      for (const child of part.parts) {
        const got = walk(child);
        if (got) return got;
      }
    }
    return '';
  };
  return walk(payload)?.slice(0, 2000) || '';
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function buildPrompt(emails, days) {
  const lines = [];
  lines.push(
`You are an analyst. Read the email snippets below and produce a concise, practical report.

Rules:
- Respond with VALID JSON ONLY (no markdown, no backticks, no extra text).
- If you are unsure, leave arrays empty.
- Do NOT include disclaimers.

Return a JSON object with exactly these keys:
{
  "summary": string,
  "important_topics": string[],
  "action_items": string[],
  "key_contacts": string[],
  "sentiment": "positive"|"neutral"|"negative"
}

Analyze ${emails.length} emails from the past ${days} days:`
  );

  emails.forEach((e, i) => {
    lines.push(
`---
Email ${i + 1}
From: ${e.from}
Subject: ${e.subject}
Date: ${e.date}
Snippet: ${e.snippet}`
    );
  });

  return lines.join('\n');
}

function validateShape(obj) {
  const safe = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  return {
    summary: typeof obj?.summary === 'string' ? obj.summary : 'No summary available.',
    important_topics: safe(obj?.important_topics),
    action_items: safe(obj?.action_items),
    key_contacts: safe(obj?.key_contacts),
    sentiment: ['positive', 'neutral', 'negative'].includes(obj?.sentiment) ? obj.sentiment : 'neutral'
  };
}

exports.handler = async (event) => {
  try {
    console.log('Event received:', JSON.stringify({ user_email: event.user_email, days: event.days }));

    const { user_email, credentials, days = 7 } = event || {};
    if (!user_email || !credentials) {
      return { statusCode: 400, body: { error: 'Missing user_email or credentials' } };
    }

    // Gmail auth
    const oauth2Client = new google.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      'http://localhost:5000/oauth2callback'
    );
    oauth2Client.setCredentials({
      access_token: credentials.token,
      refresh_token: credentials.refresh_token,
      scope: Array.isArray(credentials.scopes) ? credentials.scopes.join(' ') : credentials.scopes,
      token_type: 'Bearer'
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

 
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - Number(days));
    const afterTimestamp = Math.floor(afterDate.getTime() / 1000);
    const q = `after:${afterTimestamp} -category:promotions -category:social`;

    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 50 });
    const messageIds = list.data.messages || [];
    console.log(`✓ Found ${messageIds.length} messages in Gmail`);

    if (!messageIds.length) {
      return {
        statusCode: 200,
        body: {
          summary: 'No emails found for the selected period/categories.',
          total_emails: 0,
          important_topics: [],
          action_items: [],
          key_contacts: [],
          sentiment: 'neutral',
          period_days: Number(days),
          summarized_emails: 0,
          model_used: MODEL_ID,
          region: REGION
        }
      };
    }

    const details = await Promise.all(
      messageIds.map(async ({ id }) => {
        try {
          const resp = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
          const headers = resp.data.payload?.headers || [];
          const subject = pick(headers, 'Subject') || 'No Subject';
          const from = pick(headers, 'From') || 'Unknown';
          const date = pick(headers, 'Date') || '';
          const bodyText = decodeBody(resp.data.payload) || '';
          const snippet = (resp.data.snippet || bodyText || '').slice(0, PER_EMAIL_SNIPPET_LIMIT);
          return { subject, from, date, snippet };
        } catch (e) {
          console.error('gmail.users.messages.get failed:', e?.message || e);
          return null;
        }
      })
    );

    const emails = details.filter(Boolean);
    console.log(`✓ Successfully fetched ${emails.length} email details`);

    const sorted = [...emails].sort((a, b) => (b.snippet?.length || 0) - (a.snippet?.length || 0));
    let used = [];
    let approxTokens = 0;
    for (const e of sorted) {
      if (used.length >= MAX_EMAILS_FOR_MODEL) break;
      const addition = estimateTokens(
        (`From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nSnippet: ${e.snippet}\n`).length
      );
      if (approxTokens + addition > MAX_INPUT_TOKENS_BUDGET) break;
      used.push(e);
      approxTokens += addition;
    }
    console.log(`Prompt budgeting -> usedEmails=${used.length}, approxTokens=${approxTokens}, budget=${MAX_INPUT_TOKENS_BUDGET}`);

    const prompt = buildPrompt(used, days);

  
    const response = await openai.chat.completions.create({
      model: MODEL_ID,
      temperature: 0,
      response_format: { type: 'json_object' }, // <- forces valid JSON
      messages: [
        {
          role: 'system',
          content:
            'You summarize emails for a busy user. Respond ONLY with valid JSON and nothing else.'
        },
        { role: 'user', content: prompt }
      ]
    });

    const raw = response?.choices?.[0]?.message?.content?.trim() || '';
    console.log('Raw model output (truncated 500 chars):', raw.slice(0, 500));

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('❌ JSON.parse failed:', err?.message || err);
      parsed = {
        summary: 'Unable to parse model response.',
        important_topics: [],
        action_items: [],
        key_contacts: [],
        sentiment: 'neutral'
      };
    }

    const analysis = validateShape(parsed);

    const resultBody = {
      total_emails: emails.length,
      summarized_emails: used.length,
      period_days: Number(days),
      ...analysis,
      model_used: MODEL_ID,
      region: REGION
    };


    const key = `reports/${user_email}/${Date.now()}.json`;
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: JSON.stringify({
        user_email,
        generated_at: new Date().toISOString(),
        result: resultBody
      }),
      ContentType: 'application/json'
    }));

    console.log(`✓ Report saved to s3://${process.env.S3_BUCKET_NAME}/${key}`);
    return { statusCode: 200, body: { ...resultBody, s3_location: key } };

  } catch (error) {
    console.error('Handler error:', error);
    return { statusCode: 500, body: { error: error?.message || String(error) } };
  }
};

