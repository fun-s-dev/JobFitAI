#!/usr/bin/env node

/**
 * Production Smoke Test Script
 * Verifies live deployment health, reverse proxy routing, invite-locked registration,
 * cookie flags, and session teardown WITHOUT consuming Gemini API quota.
 *
 * Usage:
 *   FRONTEND_URL="https://jobfitai.vercel.app" \
 *   BACKEND_URL="https://jobfitai.onrender.com" \
 *   INVITE_CODE="my-secret-invite" \
 *   node scripts/smoke-prod.js
 */

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '');
const INVITE_CODE = process.env.INVITE_CODE || '';

console.log('======================================================');
console.log('JobFitAI v2 Production Deployment Smoke Test');
console.log(`Backend Target:  ${BACKEND_URL}`);
console.log(`Frontend Target: ${FRONTEND_URL}`);
console.log(`Invite Code:     ${INVITE_CODE ? '[PROVIDED]' : '[NONE]'}`);
console.log('======================================================\n');

const results = [];

function record(name, pass, details = '') {
  results.push({ name, pass, details });
  const status = pass ? '✓ PASS' : '✗ FAIL';
  console.log(`[${status}] ${name}${details ? ` (${details})` : ''}`);
}

async function runSmokeTests() {
  let sessionCookie = '';
  const testUser = {
    username: `smoke_${Date.now()}`,
    email: `m-test-smoke-${Date.now()}@example.test`,
    password: `P@ssword123!_${Date.now()}`,
    inviteCode: INVITE_CODE || undefined,
  };

  // 1. Direct Backend Liveness (/health)
  try {
    const res = await fetch(`${BACKEND_URL}/health`);
    const data = await res.json();
    const isOk = res.status === 200 && data.status === 'ok';
    record('Backend Liveness (/health)', isOk, `Status ${res.status}, uptime: ${Math.round(data.uptime || 0)}s`);
  } catch (err) {
    record('Backend Liveness (/health)', false, `Error: ${err.message}`);
  }

  // 2. Direct Backend Readiness (/ready)
  try {
    const res = await fetch(`${BACKEND_URL}/ready`);
    const data = await res.json();
    const isReady = res.status === 200 && data.status === 'ready' && data.mongo === 'connected';
    record('Backend Readiness (/ready)', isReady, `Status ${res.status}, mongo: ${data.mongo || 'unknown'}`);
  } catch (err) {
    record('Backend Readiness (/ready)', false, `Error: ${err.message}`);
  }

  // 3. Frontend Reverse-Proxy Check (/api/v2/health via FRONTEND_URL)
  try {
    const res = await fetch(`${FRONTEND_URL}/api/v2/health`);
    const data = await res.json();
    const isProxied = res.status === 200 && data.status === 'ok' && data.version === 'v2';
    record('Frontend Reverse Proxy (/api/v2/health)', isProxied, `Status ${res.status}, version: ${data.version || 'unknown'}`);
  } catch (err) {
    record('Frontend Reverse Proxy (/api/v2/health)', false, `Error: ${err.message}`);
  }

  // 4. Registration with Invite Code
  try {
    const res = await fetch(`${FRONTEND_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testUser),
    });

    const data = await res.json();
    const isCreated = res.status === 201 && data.user && data.user.email === testUser.email;
    record('Registration with Invite Code', isCreated, `Status ${res.status}, email: ${testUser.email}`);

    // Extract Cookie
    const rawCookie = res.headers.get('set-cookie');
    if (rawCookie) {
      sessionCookie = rawCookie.split(';')[0];

      // 5. Cookie Flag Assertions
      const hasHttpOnly = /HttpOnly/i.test(rawCookie);
      const hasSameSiteLax = /SameSite=Lax/i.test(rawCookie);
      const isHttps = FRONTEND_URL.startsWith('https://');
      const hasSecure = !isHttps || /Secure/i.test(rawCookie);

      const cookieFlagsValid = hasHttpOnly && hasSameSiteLax && hasSecure;
      record('Cookie Security Flags', cookieFlagsValid, `HttpOnly: ${hasHttpOnly}, SameSite=Lax: ${hasSameSiteLax}, Secure: ${hasSecure}`);
    } else {
      record('Cookie Security Flags', false, 'No set-cookie header received');
    }
  } catch (err) {
    record('Registration with Invite Code', false, `Error: ${err.message}`);
  }

  // 6. Authenticated Session Retrieval (/api/auth/get-me)
  if (sessionCookie) {
    try {
      const res = await fetch(`${FRONTEND_URL}/api/auth/get-me`, {
        headers: { Cookie: sessionCookie },
      });
      const data = await res.json();
      const isAuth = res.status === 200 && data.user && data.user.email === testUser.email;
      record('Authenticated Session (/api/auth/get-me)', isAuth, `Status ${res.status}`);
    } catch (err) {
      record('Authenticated Session (/api/auth/get-me)', false, `Error: ${err.message}`);
    }
  }

  // 7. Logout and Blacklist
  if (sessionCookie) {
    try {
      const res = await fetch(`${FRONTEND_URL}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      });
      const data = await res.json();
      const isLoggedOut = res.status === 200;
      record('Logout and Session Teardown (/api/auth/logout)', isLoggedOut, `Status ${res.status}, msg: ${data.message || ''}`);
    } catch (err) {
      record('Logout and Session Teardown (/api/auth/logout)', false, `Error: ${err.message}`);
    }
  }

  // Summary
  console.log('\n======================================================');
  console.log('Smoke Test Results Summary:');
  console.log('======================================================');
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`Overall: ${passed}/${total} checks passed (${passed === total ? 'ALL PASS' : 'SOME FAILED'}).`);

  if (passed !== total) {
    console.log('\nDiagnostic Recommendations:');
    results
      .filter((r) => !r.pass)
      .forEach((r) => {
        if (r.name.includes('Liveness')) {
          console.log('- Backend Liveness Failed: Check Render deployment logs and cold-start spin-up.');
        } else if (r.name.includes('Readiness')) {
          console.log('- Backend Readiness Failed: Check MongoDB Atlas IP access whitelist (0.0.0.0/0) and credentials in MONGO_URI.');
        } else if (r.name.includes('Proxy')) {
          console.log('- Frontend Proxy Failed: Verify destination URL in Frontend/vercel.json or Frontend/netlify.toml matches the Render URL.');
        } else if (r.name.includes('Registration')) {
          console.log('- Registration Failed: If REGISTRATION_OPEN is false, ensure INVITE_CODE matches the environment variable in Render.');
        } else if (r.name.includes('Cookie')) {
          console.log('- Cookie Flags Failed: Ensure HTTPS is enabled in production and same-origin proxy is active.');
        }
      });
    process.exit(1);
  } else {
    console.log('Ready for live production deployment.');
    process.exit(0);
  }
}

runSmokeTests();
