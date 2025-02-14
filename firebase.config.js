const admin = require('firebase-admin');
const serviceAccount = {
    type: process.env.VITE_type,
    project_id: process.env.VITE_project_id,
    private_key_id: process.env.VITE_private_key_id,
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
