Email Markdown Files

Place Markdown files here to seed or template in-game emails.

Metadata Header (simple):

From: sender@example.com
Subject: Subject line
Banner: true|false
Deleted: true|false

Follow the metadata header with a blank line, then the email body.

Example:

From: vlad@strtupify.io
Subject: How to email
Banner: false
Deleted: false

Hello End User,
...

Files in this folder are copied to the build at /emails and can be fetched via HttpClient.

