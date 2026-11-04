const {Router} = require('express');
const authController = require('../controllers/auth.controller');
const authRouter = Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { getCfg } = require('../v2/config/env');
const { createRateLimiter } = require('../v2/middlewares/rateLimits');
const { validateV1 } = require('../v2/middlewares/v1Http');
const { registerBodySchema, loginBodySchema, deleteAccountBodySchema } = require('../v2/schemas/v1');

const cfg = getCfg();

// Brute-force / signup-spam protection, keyed by client IP (users are not authenticated yet).
const registerLimiter = createRateLimiter({
  windowMs: cfg.RATE_LIMIT_REGISTER_WINDOW_MS,
  max: cfg.RATE_LIMIT_REGISTER_MAX,
  message: 'Too many sign-up attempts, please try again later',
});
// Only FAILED logins count, so normal users are never locked out by their own successful logins.
const loginLimiter = createRateLimiter({
  windowMs: cfg.RATE_LIMIT_LOGIN_WINDOW_MS,
  max: cfg.RATE_LIMIT_LOGIN_MAX,
  message: 'Too many failed login attempts, please try again later',
  skipSuccessfulRequests: true,
});

/**
 * @route POST /api/auth/register
 * @desc Register a new user
 * @access Public
 */
authRouter.post('/register', registerLimiter, validateV1({ body: registerBodySchema }), authController.registerUserController);

/**
 * @route POST /api/auth/login
 * @desc Login a user
 * @access Public
 */

authRouter.post('/login', loginLimiter, validateV1({ body: loginBodySchema }), authController.loginUserController);

/**
 * @route POST /api/auth/logout
 * @desc Logout a user, clear the token cookie and add the token to the blacklist
 * @access Public
 */
authRouter.post('/logout', authController.logoutUserController);



/**
 * @route DELETE /api/auth/account
 * @desc Permanently delete the account and all of its data. Requires the password again.
 * Wrong passwords count against the same failed-attempt limiter as login.
 * @access private
 */
authRouter.delete(
  '/account',
  authMiddleware.authUser,
  loginLimiter,
  validateV1({ body: deleteAccountBodySchema }),
  authController.deleteAccountController
);

/**
 * @route GET /api/auth/get-me
 * @description get the current logged in user details
 * @access private
 */
authRouter.get("/get-me", authMiddleware.authUser, authController.getMeController)



module.exports = authRouter;
