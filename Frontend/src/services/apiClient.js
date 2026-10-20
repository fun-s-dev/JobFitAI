import axios from 'axios';

/**
 * Unified Axios API Client
 * - baseURL defaults to empty string (same-origin relative proxy /api/...)
 * - Reads from VITE_API_URL or VITE_API_BASE_URL when deployed with absolute custom backend URL
 * - withCredentials: true ensures HTTP-only session cookies are passed on all requests
 */
const rawBase = import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || '';
const API_BASE = rawBase.replace(/\/$/, '');

export const api = axios.create({
  baseURL: API_BASE || undefined,
  withCredentials: true,
});

export default api;
