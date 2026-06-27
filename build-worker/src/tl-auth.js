// ── TENDERLOGIX AUTH ─────────────────────────────────────────────────────
// WhatsApp OTP flow:
//   1. Customer sends "LOGIN" to WA number
//   2. Inbound webhook fires → handleTlLoginRequest(phone, env)
//   3. OTP generated, stored (hashed), sent via WhatsApp
//   4. Customer enters OTP on /login page
//   5. POST /tl/auth/verify-otp → session token returned
//   6. Session token stored in localStorage, sent as Bearer on all /tl/* calls
//   7. Middleware verifies session on every protected endpoint

const OTP_TTL_MINUTES = 5;
const SESSION_TTL_DAYS = 30;
const OTP_RATE_LIMIT = 3; // per hour per phone

// ── Simple hash — Workers don't have bcrypt, use SHA-256 ─────────────────
async function hashOtp(otp, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(otp + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Generate a random numeric OTP ────────────────────────────────────────
function generateOtp() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

// ── Check rate limit for OTP requests ────────────────────────────────────
async function checkOtpRateLimit(phone, env) {
  const windowStart = new Date();
  windowStart.setMinutes(0, 0, 0); // top of current hour
  const windowKey = windowStart.toISOString().slice(0, 13); // YYYY-MM-DDTHH

  const row = await env.TL_DB.prepare(
    `SELECT count FROM tl_otp_rate WHERE phone=? AND window_key=?`
  ).bind(phone, windowKey).first().catch(() => null);

  if (row && row.count >= OTP_RATE_LIMIT) return false;

  if (row) {
    await env.TL_DB.prepare(
      `UPDATE tl_otp_rate SET count=count+1 WHERE phone=? AND window_key=?`
    ).bind(phone, windowKey).run().catch(() => {});
  } else {
    await env.TL_DB.prepare(
      `INSERT OR IGNORE INTO tl_otp_rate (phone, window_key, count) VALUES (?,?,1)`
    ).bind(phone, windowKey).run().catch(() => {});
  }
  return true;
}

// ── Called by WhatsApp incoming handler when LOGIN is received ───────────
export async function handleTlLoginRequest(phone, env) {
  try {
    // Find company by phone
    const company = await env.TL_DB.prepare(
      `SELECT id, name FROM tl_companies WHERE phone=? LIMIT 1`
    ).bind(phone).first();

    if (!company) {
      return {
        found: false,
        message: `No TenderLogix account found for this number.\n\nRegister at tenderlogix.co.za/register`
      };
    }

    // Rate limit check
    const allowed = await checkOtpRateLimit(phone, env);
    if (!allowed) {
      return {
        found: true,
        message: `Too many requests. Please wait an hour before requesting another code.`
      };
    }

    // Generate OTP
    const otp = generateOtp();
    const salt = crypto.randomUUID();
    const hash = await hashOtp(otp, salt);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

    // Expire any existing unused OTPs for this phone
    await env.TL_DB.prepare(
      `UPDATE tl_otp SET used=1 WHERE phone=? AND used=0`
    ).bind(phone).run().catch(() => {});

    // Store new OTP
    await env.TL_DB.prepare(
      `INSERT INTO tl_otp (id, company_id, phone, otp_hash, salt, expires_at) VALUES (?,?,?,?,?,?)`
    ).bind(crypto.randomUUID(), company.id, phone, hash, salt, expiresAt).run();

    return {
      found: true,
      otp: otp, // returned so the caller can send it via WhatsApp
      message: `Your TenderLogix sign-in code is:\n\n*${otp}*\n\nValid for ${OTP_TTL_MINUTES} minutes. Do not share this code.`
    };

  } catch(e) {
    console.error('handleTlLoginRequest error:', e.message);
    return { found: false, message: `Something went wrong. Please try again.` };
  }
}

// ── POST /tl/auth/verify-otp ─────────────────────────────────────────────
export async function handleTlVerifyOtp(request, env) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json',
  };

  try {
    const { otp } = await request.json();
    if (!otp || !/^\d{6}$/.test(otp)) {
      return new Response(JSON.stringify({ error: 'Invalid code format' }), { status: 400, headers: cors });
    }

    // Find all unexpired, unused OTPs — check against each
    const rows = await env.TL_DB.prepare(
      `SELECT id, company_id, phone, otp_hash, salt, attempts FROM tl_otp
       WHERE used=0 AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 10`
    ).all();

    let matchedOtp = null;
    for (const row of (rows.results || [])) {
      // Lock out after 5 failed attempts — prevents brute force of 6-digit OTP
      if ((row.attempts || 0) >= 5) continue;
      const hash = await hashOtp(otp, row.salt);
      if (hash === row.otp_hash) {
        matchedOtp = row;
        break;
      } else {
        // Increment attempt counter on each miss
        await env.TL_DB.prepare(`UPDATE tl_otp SET attempts=COALESCE(attempts,0)+1 WHERE id=?`).bind(row.id).run();
      }
    }

    if (!matchedOtp) {
      return new Response(JSON.stringify({ error: 'Invalid or expired code. Request a new one.' }), { status: 401, headers: cors });
    }

    // Mark OTP as used
    await env.TL_DB.prepare(`UPDATE tl_otp SET used=1 WHERE id=?`).bind(matchedOtp.id).run();

    // Get company name
    const company = await env.TL_DB.prepare(
      `SELECT id, name FROM tl_companies WHERE id=? LIMIT 1`
    ).bind(matchedOtp.company_id).first();

    // Create session
    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await env.TL_DB.prepare(
      `INSERT INTO tl_sessions (id, company_id, phone, expires_at) VALUES (?,?,?,?)`
    ).bind(sessionToken, matchedOtp.company_id, matchedOtp.phone, expiresAt).run();

    return new Response(JSON.stringify({
      success: true,
      session_token: sessionToken,
      company_id: matchedOtp.company_id,
      company_name: company?.name || '',
    }), { status: 200, headers: cors });

  } catch(e) {
    console.error('handleTlVerifyOtp error:', e.message);
    return new Response(JSON.stringify({ error: 'Verification failed' }), { status: 500, headers: cors });
  }
}

// ── GET /tl/auth/check ───────────────────────────────────────────────────
export async function handleTlAuthCheck(request, env) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const session = await getSession(request, env);
  if (!session) return new Response(JSON.stringify({ valid: false }), { headers: cors });
  const company = await env.TL_DB.prepare('SELECT slug FROM tl_companies WHERE id=?').bind(session.company_id).first();
  return new Response(JSON.stringify({ valid: true, company_id: session.company_id, slug: company?.slug || null }), { headers: cors });
}

// ── POST /tl/auth/logout ─────────────────────────────────────────────────
export async function handleTlLogout(request, env) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const token = getSessionToken(request);
    if (token) {
      await env.TL_DB.prepare(`DELETE FROM tl_sessions WHERE id=?`).bind(token).run();
    }
  } catch(e) {}
  return new Response(JSON.stringify({ success: true }), { headers: cors });
}

// ── Session helpers ───────────────────────────────────────────────────────
function getSessionToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  // Also check cookie
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/tl_session=([^;]+)/);
  return match ? match[1] : null;
}

export async function getSession(request, env) {
  const token = getSessionToken(request);
  if (!token) return null;
  try {
    const session = await env.TL_DB.prepare(
      `SELECT id, company_id, phone FROM tl_sessions
       WHERE id=? AND expires_at > datetime('now') LIMIT 1`
    ).bind(token).first();
    if (!session) return null;
    // Refresh last_seen
    await env.TL_DB.prepare(
      `UPDATE tl_sessions SET last_seen=datetime('now') WHERE id=?`
    ).bind(token).run().catch(() => {});
    return session;
  } catch(e) {
    return null;
  }
}

// ── Auth middleware — call at top of any protected handler ───────────────
export async function requireTlAuth(request, env) {
  if (request.method === 'OPTIONS') return null; // allow CORS preflight
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorised', redirect: '/login' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
  return null; // null = auth passed, continue
}

