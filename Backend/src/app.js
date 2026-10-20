const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { createHttpLogger } = require('./v2/utils/logger');
const { getCfg } = require('./v2/config/env');

const app = express();

// Trust reverse proxy (e.g. Render, Railway, Fly, Nginx - configurable hops)
let trustProxyHops = 1;
try {
  trustProxyHops = getCfg().TRUST_PROXY_HOPS ?? 1;
} catch {
  trustProxyHops = Number(process.env.TRUST_PROXY_HOPS) || 1;
}
app.set('trust proxy', trustProxyHops);

app.use(helmet());
app.use(createHttpLogger());

app.use(express.json());
app.use(cookieParser());

let frontendOrigin = 'http://localhost:5173';
try {
  frontendOrigin = getCfg().FRONTEND_URL || process.env.FRONTEND_URL || frontendOrigin;
} catch {
  frontendOrigin = process.env.FRONTEND_URL || frontendOrigin;
}

app.use(cors({
    origin: frontendOrigin,
    credentials: true
}));

// Liveness probe (does not require Mongo)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Readiness probe (verifies Mongo connection)
app.get('/ready', (req, res) => {
    const isMongoConnected = mongoose.connection.readyState === 1;
    if (isMongoConnected) {
        return res.status(200).json({
            status: 'ready',
            mongo: 'connected',
            timestamp: new Date().toISOString()
        });
    }
    return res.status(503).json({
        status: 'not_ready',
        mongo: 'disconnected',
        timestamp: new Date().toISOString()
    });
});

/* require all the routes here*/
const authRouter = require('./routes/auth.routes');
const interviewRouter = require("./routes/interview.routes");
const v2Router = require('./v2/routes/v2.routes');

/* using all the routes here*/
app.use('/api/auth', authRouter);
app.use('/api/interview', interviewRouter);
app.use('/api/v2', v2Router);

module.exports = app;