import React, { Suspense, lazy } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import Login from "./features/auth/pages/Login";
import Register from "./features/auth/pages/Register";
import Protected from "./features/auth/components/protected";
import Home from "./features/interview/pages/Home";

// Heavier pages are loaded on demand to keep the first bundle small
const Interview = lazy(() => import("./features/interview/pages/Interview"));
const VerificationPage = lazy(() => import("./features/verification/pages/VerificationPage"));

const PageFallback = () => (
    <main className="loading-screen">
        <h1>Loading...</h1>
    </main>
);

const lazyPage = (element) => (
    <Protected>
        <Suspense fallback={<PageFallback />}>{element}</Suspense>
    </Protected>
);

export const routes = [
    {
        path: "/login",
        element: <Login />
    },
    {
        path: "/register",
        element: <Register />
    },
    {
        path: "/",
        element: <Protected><Home /></Protected>
    },
    {
        path: "/interview/:interviewId",
        element: lazyPage(<Interview />)
    },
    {
        path: "/interview/:interviewId/verify",
        element: lazyPage(<VerificationPage />)
    },
    {
        // Unknown URLs go home instead of showing a blank page
        path: "*",
        element: <Navigate to="/" replace />
    }
];

export const router = createBrowserRouter(routes);
