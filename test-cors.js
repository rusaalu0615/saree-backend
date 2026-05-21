const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
    origin: (origin, callback) => {
        // Return requesting origin to allow credentials transport dynamically
        callback(null, origin || true);
    },
    credentials: true
}));

app.options('*', cors());

app.post('/api', (req, res) => {
    res.json({ ok: true });
});

app.listen(5001, () => console.log('Test server on 5001'));
