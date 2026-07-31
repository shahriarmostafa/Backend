const admin = require('firebase-admin');

/**
 * The Firebase service account, assembled from environment variables.
 *
 * This file used to go straight to `process.env.VITE_private_key.replace(...)`,
 * so a missing variable killed the process at require time with
 *
 *     TypeError: Cannot read properties of undefined (reading 'replace')
 *
 * which says nothing about which variable, or that the cause is configuration
 * at all. It is the first thing that runs on a cold deploy, so that stack trace
 * was the only signal. Fail with the names instead.
 */
const REQUIRED_KEYS = [
    'VITE_type',
    'VITE_project_id',
    'VITE_private_key_id',
    'VITE_private_key',
    'VITE_client_email',
    'VITE_client_id',
    'VITE_auth_uri',
    'VITE_token_uri',
    'VITE_auth_provider_x509_cert_url',
    'VITE_client_x509_cert_url',
    'VITE_universe_domain',
];

const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);
if (missing.length) {
    throw new Error(
        `Firebase admin cannot start: ${missing.length} environment variable(s) are not set — ` +
        `${missing.join(', ')}. These come from the Firebase service account JSON. ` +
        `Set them on the host (Render: Environment → Environment Variables). ` +
        `VITE_private_key must keep its literal \\n escapes; they are unescaped here.`
    );
}

const serviceAccount = {
    type: process.env.VITE_type,
    project_id: process.env.VITE_project_id,
    private_key_id: process.env.VITE_private_key_id,
    // the key is stored with literal \n two-character sequences
    private_key: process.env.VITE_private_key.replace(/\\n/g, '\n'),
    client_email: process.env.VITE_client_email,
    client_id: process.env.VITE_client_id,
    auth_uri: process.env.VITE_auth_uri,
    token_uri: process.env.VITE_token_uri,
    auth_provider_x509_cert_url: process.env.VITE_auth_provider_x509_cert_url,
    client_x509_cert_url: process.env.VITE_client_x509_cert_url,
    universe_domain: process.env.VITE_universe_domain
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://poperl-1st.firebaseapp.com"
});

const database = admin.firestore();

module.exports = {database, admin};
