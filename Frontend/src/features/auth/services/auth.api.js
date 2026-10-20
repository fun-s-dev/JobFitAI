import { api } from "../../../services/apiClient";

export async function register({ username, email, password, inviteCode }) {
    try {
        const payload = { username, email, password };
        if (inviteCode) {
            payload.inviteCode = inviteCode;
        }
        const response = await api.post('/api/auth/register', payload);
        return response.data;
    } catch (err) {
        throw new Error(err.response?.data?.message || err.message || "Registration failed");
    }
}

export async function login({ email, password }) {
    try {
        const response = await api.post("/api/auth/login", {
            email, password
        });
        return response.data;
    } catch (err) {
        throw new Error(err.response?.data?.message || err.message || "Login failed");
    }
}

export async function logout() {
    try {
        const response = await api.post("/api/auth/logout");
        return response.data;
    } catch (err) {
        console.warn('Logout request failed:', err.message || 'Network error');
        return { message: 'Logged out locally' };
    }
}

export async function getMe() {
    try {
        const response = await api.get("/api/auth/get-me");
        return response.data;
    } catch {
        // Normal unauthenticated state when no valid session cookie exists
        return null;
    }
}