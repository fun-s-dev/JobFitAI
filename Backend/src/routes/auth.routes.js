const {Router} = require('express');
const authController = require('../controllers/auth.controller');
const authRouter = Router();
const authMiddleware = require('../middlewares/auth.middleware');
/**
 * @route POST /api/auth/register
 * @desc Register a new user
 * @access Public
 */
authRouter.post('/register', authController.registerUserController);

/**
 * @route POST /api/auth/login
 * @desc Login a user
 * @access Public
 */

authRouter.post('/login', authController.loginUserController);

/**
 * @route GET /api/auth/logout
 * @desc Logout a user, clear the token cookie and add the token to the blacklist
 * @access Public
 */
authRouter.get('/logout', authController.logoutUserController);



/**
 * @route GET /api/auth/get-me
 * @description get the current logged in user details
 * @access private
 */
authRouter.get("/get-me", authMiddleware.authUser, authController.getMeController)



module.exports = authRouter;