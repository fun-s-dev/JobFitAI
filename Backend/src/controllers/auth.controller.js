const crypto = require('node:crypto');
const userModel = require('../models/user.model');
const { createUserDataService, UserDataError } = require('../v2/services/userData.service');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const tokenBlacklistModel = require('../models/blacklist.model');
const { getCfg } = require('../v2/config/env');
const { sendV1Error } = require('../v2/middlewares/v1Http');

function getCookieOptions() {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    };
}

/** Constant-time string comparison (avoids leaking the invite code through response timing). */
function safeEqual(a, b) {
    const left = crypto.createHash('sha256').update(String(a)).digest();
    const right = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(left, right);
}

function signToken(user) {
    return jwt.sign(
        {id: user._id, username: user.username },
        process.env.JWT_SECRET,
        {expiresIn: '1d'}
    );
}

/**
 * 
 * @name registerUserController
 * @description register a new user, expect username, email and password in the request body
 * (already validated, trimmed and normalized by validateV1 + registerBodySchema)
 * @access Public
 * 
 */
async function registerUserController(req,res){
    const {username, email, password, inviteCode} = req.body;

    const cfg = getCfg();
    const isRegistrationOpen = process.env.REGISTRATION_OPEN !== undefined
        ? (process.env.REGISTRATION_OPEN === 'true' || process.env.REGISTRATION_OPEN === true)
        : cfg.REGISTRATION_OPEN;
    const requiredInviteCode = process.env.INVITE_CODE !== undefined
        ? process.env.INVITE_CODE
        : cfg.INVITE_CODE;

    if (!isRegistrationOpen) {
        if (!requiredInviteCode) {
            return sendV1Error(req, res, 403, 'REGISTRATION_CLOSED', "Registration is currently closed");
        }
        if (!inviteCode || !safeEqual(inviteCode, requiredInviteCode)) {
            return sendV1Error(req, res, 403, 'INVITE_CODE_REQUIRED', "Registration is closed. A valid invite code is required.");
        }
    }

    const isUserAlreadyExists = await userModel.findOne({$or: [{email}, {username}]})

    if(isUserAlreadyExists){
        return sendV1Error(req, res, 400, 'ACCOUNT_EXISTS', "Account with this email or username already exists");
    }

    const hash = await bcrypt.hash(password, 10)

    const user = new userModel({
        username,
        email,
        password: hash
    })

    try {
        await user.save() // save the user to the database
    } catch (err) {
        // Two simultaneous sign-ups can both pass the check above; the unique index decides.
        if (err && err.code === 11000) {
            return sendV1Error(req, res, 400, 'ACCOUNT_EXISTS', "Account with this email or username already exists");
        }
        throw err;
    }

    const token = signToken(user)

    res.cookie('token', token, getCookieOptions())
    
    res.status(201).json({
        message: "User registered successfully",
        user: {
            id: user._id,
            username: user.username,
            email: user.email
        }
    })

}

/**
 * @name loginUserController
 * @description login a user, expect email and password in the request body
 * @access Public
 */

async function loginUserController(req,res){
    const {email, password} = req.body;

    // New accounts store lowercase emails. Accounts created before normalization may have mixed case,
    // so match either the normalized or the exact value the user typed.
    const normalizedEmail = email.toLowerCase();
    const user = await userModel.findOne({ email: { $in: [normalizedEmail, email] } })

    if(!user){
        return sendV1Error(req, res, 400, 'INVALID_CREDENTIALS', "Invalid email or password");
    }

    const isPasswordValid = await bcrypt.compare(password, user.password)

    if(!isPasswordValid){
        return sendV1Error(req, res, 400, 'INVALID_CREDENTIALS', "Invalid email or password");
    }

    const token = signToken(user)

    res.cookie('token', token, getCookieOptions())

    res.status(200).json({
        message: "User logged in successfully",
        user: {
            id: user._id,
            username: user.username,
            email: user.email
        }
    })
}

/**
 * @name logoutUserController
 * @description clear token from user cookie and add the token in blacklist
 * @access public
 */
async function logoutUserController(req,res){
    const token = req.cookies.token;
    if(typeof token === 'string' && token){
        await tokenBlacklistModel.create({token})
    }

    res.clearCookie('token', getCookieOptions())

    res.status(200).json({message: "User logged out successfully"})
}


let activeUserDataService = null;

/** Built lazily so requiring this module never loads the V2 GitHub controller during app startup order. */
function getUserDataService() {
    if (!activeUserDataService) {
        activeUserDataService = createUserDataService({
            models: {
                InterviewReport: require('../models/interviewReport.model'),
                ResumeDraft: require('../v2/models/resumeDraft.model'),
                VerificationRun: require('../v2/models/verificationRun.model'),
                ResumeClaim: require('../v2/models/resumeClaim.model'),
                Job: require('../v2/models/job'),
                ReportProjectLink: require('../v2/models/reportProjectLink.model'),
                RepoRanking: require('../v2/models/repoRanking.model'),
                LlmCall: require('../v2/models/llmCall.model'),
                GithubOauthState: require('../v2/models/githubOauthState.model'),
                User: userModel,
            },
            disconnectGithub: (userId) => require('../v2/controllers/github.controller').disconnectGithubForUser(userId),
        });
    }
    return activeUserDataService;
}

/** Shared with the interview controller (report deletion). */
function setUserDataService(service) {
    activeUserDataService = service || null;
}

/**
 * @name deleteAccountController
 * @description permanently delete the logged-in user and all their data. Requires the password again.
 * @access private
 */
async function deleteAccountController(req, res) {
    const user = await userModel.findById(req.user.id)

    if (!user) {
        return sendV1Error(req, res, 401, 'UNAUTHORIZED', "Account no longer exists.");
    }

    const passwordOk = await bcrypt.compare(req.body.password, user.password)
    if (!passwordOk) {
        return sendV1Error(req, res, 400, 'INVALID_PASSWORD', "Incorrect password.");
    }

    try {
        await getUserDataService().deleteAccount({ userId: user._id })
    } catch (err) {
        if (err instanceof UserDataError) {
            return sendV1Error(req, res, err.status, err.code, err.message);
        }
        throw err
    }

    // End the session: blacklist the current token and clear the cookie
    const token = req.cookies.token;
    if (typeof token === 'string' && token) {
        await tokenBlacklistModel.create({token})
    }
    res.clearCookie('token', getCookieOptions())

    res.status(200).json({ message: "Your account and all of its data were deleted." })
}

/**
 * @name getMeController
 * @description get the current logged in user details.
 * @access private
 */
async function getMeController(req, res) {

    const user = await userModel.findById(req.user.id)

    // A valid token for a deleted account must not crash the request
    if (!user) {
        return sendV1Error(req, res, 401, 'UNAUTHORIZED', "Account no longer exists.");
    }

    res.status(200).json({
        message: "User details fetched successfully",
        user: {
            id: user._id,
            username: user.username,
            email: user.email
        }
    })

}


module.exports = {
    registerUserController,
    loginUserController,
    logoutUserController,
    getMeController,
    deleteAccountController,
    getUserDataService,
    setUserDataService
}
