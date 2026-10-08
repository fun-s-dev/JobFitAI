const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const { createHttpLogger } = require('./v2/utils/logger');

const app = express();

app.use(helmet());
app.use(createHttpLogger());

app.use(express.json());
app.use(cookieParser());
app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true
}));

/* require all the routes here*/
const authRouter = require('./routes/auth.routes');
const interviewRouter = require("./routes/interview.routes");
const v2Router = require('./v2/routes/v2.routes');

/* using all the routes here*/
app.use('/api/auth', authRouter);
app.use('/api/interview', interviewRouter);
app.use('/api/v2', v2Router);

module.exports = app;