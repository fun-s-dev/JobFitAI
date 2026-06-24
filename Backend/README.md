# JobFitAI Backend

Node.js, Express, and MongoDB backend for the JobFitAI application. The API currently provides authentication endpoints for user registration, login, logout, and fetching the authenticated user profile.

## Features

- Express API with MongoDB via Mongoose
- JWT-based authentication stored in an HTTP cookie
- Password hashing with `bcryptjs`
- Token blacklist support for logout

## Prerequisites

- Node.js 18 or newer
- npm
- A MongoDB database connection string

## Installation

1. Install dependencies:

```bash
npm install
```

2. Create a local environment file from the example:

```bash
copy .env.example .env
```

3. Fill in the required values in `.env`.

## Environment Variables

The backend uses the following environment variables:

- `PORT` - Server port, defaults to `3000` when not provided.
- `MONGO_URI` - MongoDB connection string.
- `JWT_SECRET` - Secret used to sign and verify JWTs.

## Running Locally

Start the production server:

```bash
npm start
```

Start the development server with automatic restarts:

```bash
npm run dev
```

## API Endpoints

Base URL: `/api/auth`

- `POST /api/auth/register` - Register a new user with `username`, `email`, and `password`.
- `POST /api/auth/login` - Log in with `email` and `password`.
- `GET /api/auth/logout` - Log out the current user and blacklist the active token.
- `GET /api/auth/get-me` - Get the authenticated user's profile. Requires a valid token cookie.

## Public Safety Checklist

- `.env` files are ignored by git.
- `node_modules/` is ignored by git.
- No API keys, tokens, database URIs, or credentials are hardcoded in the application source.
- Secrets should live only in local environment files that are not committed.

## Notes

- The API expects MongoDB to be available before startup.
- Auth tokens are stored in cookies and blacklisted on logout.