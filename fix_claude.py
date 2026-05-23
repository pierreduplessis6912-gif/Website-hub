import os

path = os.path.expanduser('~/Website-hub/pulse-worker/src/index.js')
c = open(path).read()

# FIX 1: Change invalid model name to valid one
old_model = "'claude-sonnet-4-20250514'"
new_model = "'claude-3-5-sonnet-20241022'"

if old_model in c:
    c = c.replace(old_model, new_model, 1)
    print('FIXED: model name')
else:
    print('Model name not found or already fixed')

# FIX 2: Replace unsafe Claude API block with safe parsing
old_block = """    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const apiData = await apiRes.json();
    const text    = apiData?.content?.[0]?.text || '';
    const clean   = text.replace(/```json|```/g, '').trim();
    decision      = JSON.parse(clean);"""

new_block = """    let claudeRawResponse = '';
    let claudeStatusCode = 0;
    
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    claudeStatusCode = apiRes.status;
    const rawText = await apiRes.text();
    claudeRawResponse = rawText.slice(0, 2000);
    
    if (!apiRes.ok) {
      throw new Error(`Claude API returned HTTP ${claudeStatusCode}: ${rawText.slice(0, 500)}`);
    }
    
    const apiData = JSON.parse(rawText);
    const text    = apiData?.content?.[0]?.text || '';
    
    if (!text) {
      throw new Error(`Claude returned empty content. Response: ${rawText.slice(0, 500)}`);
    }
    
    const clean   = text.replace(/```json|```/g, '').trim();
    decision      = JSON.parse(clean);"""

if old_block in c:
    c = c.replace(old_block, new_block, 1)
    print('FIXED: Claude API call block')
else:
    print('Claude API block not found')

# FIX 3: Update error logging
old_err = """    console.warn('Claude API call failed:', err?.message);
    await logEvent(env, 'pulse', 'autonomy_claude_error', 'failure', {
      metadata: { signature: failure.signature, error: err.message },
    });"""

new_err = """    console.warn('Claude API call failed:', err?.message);
    console.warn('Claude raw response (first 1000 chars):', claudeRawResponse);
    console.warn('Claude HTTP status:', claudeStatusCode);
    
    await logEvent(env, 'pulse', 'autonomy_claude_error', 'failure', {
      metadata: { 
        signature: failure.signature, 
        error: err.message,
        claude_status: claudeStatusCode,
        claude_raw: claudeRawResponse.slice(0, 500),
      },
    });"""

if old_err in c:
    c = c.replace(old_err, new_err, 1)
    print('FIXED: error logging')
else:
    print('Error log block not found')

open(path, 'w').write(c)
print('Done. File written.')
