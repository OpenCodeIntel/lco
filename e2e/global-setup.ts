// e2e/global-setup.ts
// Runs once before all Playwright tests.
// Generates the self-signed TLS cert for the mock server if it does not already exist.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(__dirname, 'certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');

export default function globalSetup() {
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) return;

    console.log('[E2E] Generating self-signed TLS cert for mock claude.ai server...');
    execSync(
        `openssl req -x509 -newkey rsa:2048 -nodes \
         -keyout "${KEY_FILE}" -out "${CERT_FILE}" \
         -days 365 \
         -subj "/CN=claude.ai" \
         -addext "subjectAltName=DNS:claude.ai"`,
        { stdio: 'pipe' },
    );
    console.log('[E2E] Cert generated.');
}
