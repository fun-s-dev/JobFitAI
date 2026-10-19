const express = require('express');
const { authUser } = require('../../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate');
const { jobParamsSchema } = require('../schemas/job');
const { getJobById } = require('../controllers/job.controller');

const router = express.Router();

// GET /api/v2/jobs/:id (authUser -> validate -> controller with 404 ownership defense)
router.get(
  '/:id',
  authUser,
  validate({ params: jobParamsSchema }),
  getJobById
);

module.exports = router;
