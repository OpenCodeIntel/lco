#!/bin/bash
# Generate a self-signed TLS certificate for claude.ai (mock testing only).
# The cert is trusted by Chromium via --ignore-certificate-errors.
set -e
cd "$(dirname "$0")"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem \
  -days 365 \
  -subj "/CN=claude.ai" \
  -addext "subjectAltName=DNS:claude.ai"

echo "Generated cert.pem and key.pem for claude.ai"
