# JobFitAI

## Project Overview
JobFitAI is an intelligent platform designed to help candidates prepare for job interviews. By leveraging the power of Google's Gemini AI, the application analyzes a candidate's resume and a target job description to generate a comprehensive, personalized interview preparation plan. It provides a match score, tailored technical and behavioral questions, skill gap analysis, and a structured day by day preparation roadmap.

## Features
* **AI Powered Analysis**: Compares your resume or self description against any job description to evaluate your fit.
* **Match Score**: Instantly see how well your profile aligns with the role.
* **Custom Question Banks**: Get technical and behavioral questions specific to the job, complete with the interviewer's intention and model answers.
* **Skill Gap Identification**: Discover exactly which skills you need to brush up on, prioritized by severity.
* **Preparation Roadmap**: Receive a structured, multi day plan with actionable tasks to prepare effectively.
* **Resume Tailoring**: Generate an optimized, ATS friendly PDF resume tailored specifically to the target role.
* **User Authentication**: Securely register, log in, and save all your past interview reports to track your progress.

## Tech Stack

### Frontend
* **React 19**: Modern UI development.
* **Vite**: Fast frontend tooling and bundling.
* **React Router**: Client side routing.
* **Sass (SCSS)**: Advanced styling and theming.
* **Axios**: HTTP client for API requests.

### Backend
* **Node.js & Express**: Fast and scalable web server.
* **MongoDB & Mongoose**: NoSQL database for flexible data storage.
* **Google Gen AI (Gemini)**: Core AI engine for report and resume generation.
* **Multer**: Middleware for handling multipart/form data (resume uploads).
* **PDF Parse**: Extracting text from uploaded PDF resumes.
* **Puppeteer**: Generating custom PDF resumes from HTML.
* **Zod**: Type safe schema validation for structured AI outputs.
* **JWT & bcryptjs**: Secure authentication and password hashing.

## Folder Structure
```text
JobFitAI/
├── Backend/
│   ├── .env.example
│   ├── package.json
│   ├── server.js              # Application entry point
│   └── src/
│       ├── app.js             # Express app configuration
│       ├── config/            # Database and environment configurations
│       ├── controllers/       # Route handlers (Auth, Interview)
│       ├── middlewares/       # Auth validation and Multer setup
│       ├── models/            # Mongoose schemas
│       ├── routes/            # Express routers
│       └── services/          # External services (Gemini AI logic)
└── Frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── App.jsx
        ├── app.routes.jsx     # Frontend routing setup
        ├── main.jsx           # React entry point
        ├── style.scss         # Global styles
        └── features/
            ├── auth/          # Authentication pages, services, and context
            └── interview/     # Interview report pages, hooks, and API services
```

## Architecture Overview
The application follows a standard Client Server architecture. 
1. The **Frontend (React)** handles the user interface, form submissions, and state management via Context API. It communicates with the backend using Axios.
2. The **Backend (Express)** provides RESTful API endpoints. It validates authentication via JWT cookies, processes file uploads entirely in memory using Multer, and interfaces with the **Gemini AI API** to generate structured JSON data. 
3. The **Database (MongoDB)** stores user credentials securely and persists generated interview reports for future retrieval.

## Prerequisites
Before you begin, ensure you have the following installed on your machine:
* **Node.js**: Version 18.x or higher
* **MongoDB**: A local instance or a cloud MongoDB Atlas URI
* **Google Gemini API Key**: Get one from Google AI Studio

## Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd JobFitAI
   ```

2. **Install Backend Dependencies:**
   ```bash
   cd Backend
   npm install
   ```

3. **Install Frontend Dependencies:**
   ```bash
   cd ../Frontend
   npm install
   ```

## Environment Variables
In the `Backend` directory, create a `.env` file based on the provided `.env.example`.

```env
# Backend/.env
PORT=3000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_secure_jwt_secret
GOOGLE_GENAI_API_KEY=your_gemini_api_key
FRONTEND_URL=http://localhost:5173
```

In the `Frontend` directory, you can optionally create a `.env` file to configure the backend API URL.

```env
# Frontend/.env
VITE_API_URL=http://localhost:3000
```

## Running the Backend
From the `Backend` directory, start the development server:
```bash
npm run dev
```
The server will start on `http://localhost:3000`.

## Running the Frontend
From the `Frontend` directory, start the Vite development server:
```bash
npm run dev
```
The application will be accessible at `http://localhost:5173`.

## API Endpoints

### Authentication (`/api/auth`)
* `POST /register`: Register a new user.
* `POST /login`: Authenticate a user and set a JWT cookie.
* `GET /logout`: Clear the authentication cookie.
* `GET /get-me`: Fetch details of the currently logged in user.

### Interview Generation (`/api/interview`)
* `POST /`: Generate a new interview report (expects `multipart/form-data` with `jobDescription`, optional `selfDescription`, and optional `resume` file).
* `GET /`: Retrieve all saved interview reports for the authenticated user.
* `GET /report/:interviewId`: Fetch a specific interview report by its ID.
* `POST /resume/pdf/:interviewReportId`: Generate and download a tailored PDF resume.

## Project Workflow
1. **User Registration/Login**: The user creates an account or logs in. A JWT token is stored in a secure cookie.
2. **Data Input**: The user inputs a target Job Description and either uploads their Resume (PDF) or types a quick Self Description.
3. **Processing**: The backend extracts text from the PDF (if provided) and sends all data to the Gemini AI model with a strict JSON schema requirement.
4. **Report Generation**: Gemini returns a structured JSON response containing the match score, questions, and roadmap.
5. **Storage**: The report is saved to MongoDB.
6. **Review**: The user views their personalized dashboard on the frontend. They can also choose to generate a newly tailored PDF resume based on the AI's suggestions.

## Screenshots

### Home Dashboard
![Home Dashboard Placeholder](/path/to/home-screenshot.png)
*Description: The main dashboard where users input job descriptions and upload resumes.*

### Interview Report
![Interview Report Placeholder](/path/to/report-screenshot.png)
*Description: The generated report showing the match score, technical questions, and preparation roadmap.*

## Future Improvements
* Add OAuth (Google/GitHub) authentication.
* Implement a mock interview feature using speech to text AI.
* Add more robust error handling and loading skeletons for a smoother UX.
* Expand resume parsing to support DOCX and other formats natively.

## Troubleshooting
* **Database Connection Issues**: Ensure your IP address is whitelisted if using MongoDB Atlas, and verify your `MONGO_URI` is correct.
* **AI Generation Fails (503/500 Error)**: Ensure your `GOOGLE_GENAI_API_KEY` is valid and has sufficient quota. The application gracefully degrades and will prompt you to try again.
* **CORS Errors**: Ensure the `FRONTEND_URL` in the backend `.env` matches the exact URL where your frontend is running.
* **PDF Generation Fails**: Puppeteer requires certain system libraries to launch Chromium. If deploying on a minimal Linux server, you may need to install additional system dependencies.

## License
This project is licensed under the ISC License. See the package.json for details.

## Author
Developed by Anjali Sinha.
