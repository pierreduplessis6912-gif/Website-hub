/**
 * RESULTS ARCHETYPE — The Invisible Backbone
 *
 * For: panel beater, flooring, renovation, landscaping, car wash,
 *      pool building, curtains/blinds, painting contractor, tiling,
 *      personal trainer, gym, before/after transformation businesses
 *
 * Feel: These are the workers we didn't know we needed. The guys behind
 *       the scenes that make us shine. Before and after is the DNA.
 *       Dark to light. Raw to refined. Broken to whole. The gallery is
 *       the hero. The testimonial is the emotional peak. The process
 *       section replaces the services list. "See what we can do for you."
 *       Quiet confidence. The work speaks.
 */

export function generateResultsHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone       = (client.phone || '').replace(/\D/g, '');
  const domain      = client.domain || `${client.slug}.co.za`;
  const waLink      = `https://wa.me/${phone}`;
  const callLink    = `tel:${client.phone || ''}`;
  const isExp       = pkg === 'express';
  const isPrem      = pkg === 'premium';

  const primary     = brandBrief?.primary_colour || '#2c5f2e';
  const accent      = brandBrief?.accent_colour  || '#97bc62';
  const svcs        = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';
  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);

  const phoneDisplay = (client.phone || '')
    .replace(/^\+?27/, '0')
    .replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Process steps — the journey they take every client on
  const processSteps = [
    { num:'01', title: 'We come to you',      body: 'Free assessment on-site. We look, we listen, we tell you exactly what\'s possible.' },
    { num:'02', title: 'We agree on a plan',  body: 'Clear quote. Realistic timeline. No surprises. You approve before we start.' },
    { num:'03', title: 'We get to work',       body: 'The team arrives when we say. We work until it\'s done. Every time.' },
    { num:'04', title: 'You walk back in',     body: 'This is the moment. We don\'t finish until you love it.' },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(t.page_title || client.business_name)}</title>
<meta name="description" content="${esc(t.meta_description || '')}">
<meta property="og:title" content="${esc(client.business_name)}">
<meta property="og:description" content="${esc(t.hero_subline || '')}">
<meta property="og:image" content="${esc(heroUrl)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --dark:#0d0f0d;
  --dark2:#131513;
  --surface:#1a1f1a;
  --border:#252a25;
  --text:#f0f2f0;
  --muted:#7a8c7a;
  --light:#f4f6f4;
  --cream:#eef0ea;
  --font-display:'Syne',system-ui,sans-serif;
  --font-body:'Inter',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--dark);color:var(--text);overflow-x:hidden}

/* ── NAV ──────────────────────────────────── */
.nav{
  position:fixed;top:0;left:0;right:0;z-index:100;
  display:flex;align-items:center;justify-content:space-between;
  padding:20px 28px;background:transparent;
  transition:background .3s,border-color .3s;
}
.nav.scrolled{
  background:rgba(13,15,13,.92);
  border-bottom:1px solid var(--border);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.nav-brand{
  font-family:var(--font-display);
  font-size:17px;font-weight:700;letter-spacing:.5px;
  color:var(--text);text-decoration:none;text-transform:uppercase;
}
.nav-links{display:flex;align-items:center;gap:14px;flex-shrink:0}
.nav-link{display:none;
  color:rgba(255,255,255,.5);font-size:13px;font-weight:400;
  text-decoration:none;letter-spacing:.3px;transition:color .2s;
}
.nav-link:hover{color:var(--text)}
.nav-cta{
  display:block!important;background:var(--primary);color:var(--text)!important;
  padding:9px 20px;border-radius:6px;
  font-weight:500;letter-spacing:.3px;transition:opacity .2s;white-space:nowrap;
}
.nav-cta:hover{opacity:.85}

/* ── HERO — the after ──────────────────────── */
.hero{
  position:relative;
  height:100svh;min-height:600px;
  display:flex;flex-direction:column;
  justify-content:flex-end;
  padding:0 28px 72px;overflow:hidden;
}
.hero-bg{
  position:absolute;inset:0;
  background-image:url('${esc(heroUrl)}');
  background-size:cover;background-position:center;
  animation:heroLift .8s cubic-bezier(.16,1,.3,1) both;
}
/* Cinematic dark overlay — heavy at bottom, reveals the work */
.hero-bg::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(
    to bottom,
    rgba(13,15,13,.2) 0%,
    rgba(13,15,13,.1) 35%,
    rgba(13,15,13,.85) 100%
  );
}
/* Reveal line — a thin accent line that sweeps in */
.hero-reveal-line{
  position:absolute;top:0;left:0;right:0;
  height:3px;
  background:linear-gradient(90deg, transparent, var(--accent), transparent);
  animation:revealLine .8s .5s ease both;
  transform-origin:left;
}
.hero-content{position:relative;z-index:2}
.hero-category{
  display:inline-flex;align-items:center;gap:10px;
  margin-bottom:20px;
  animation:liftIn .5s .3s ease both;
}
.category-bar{
  width:28px;height:2px;background:var(--accent);
}
.category-text{
  font-family:var(--font-display);
  font-size:11px;font-weight:600;
  letter-spacing:3px;text-transform:uppercase;
  color:var(--accent);
}
.hero-h1{
  font-family:var(--font-display);
  font-size:clamp(44px,11vw,80px);
  font-weight:800;line-height:1;
  letter-spacing:-1px;color:var(--text);
  margin-bottom:16px;text-transform:uppercase;
  animation:liftIn .5s .4s ease both;
}
.hero-h1 em{
  font-style:normal;color:var(--accent);
  display:block;font-weight:400;
  font-size:.75em;letter-spacing:0;
  text-transform:none;font-family:var(--font-body);
  margin-top:8px;
}
.hero-subline{
  font-size:16px;font-weight:300;
  color:rgba(255,255,255,.7);line-height:1.6;
  max-width:420px;margin-bottom:36px;
  animation:liftIn .5s .5s ease both;
}
.hero-ctas{
  display:flex;gap:12px;flex-wrap:wrap;
  animation:liftIn .5s .6s ease both;
}
.btn-results-primary{
  background:var(--primary);color:var(--text);
  padding:15px 28px;border-radius:6px;
  font-size:14px;font-weight:500;letter-spacing:.3px;
  text-decoration:none;display:inline-flex;
  align-items:center;gap:8px;
  transition:opacity .2s,transform .2s;
}
.btn-results-primary:hover{opacity:.9;transform:translateY(-1px)}
.btn-results-ghost{
  border:1px solid rgba(255,255,255,.2);color:var(--text);
  padding:14px 28px;border-radius:6px;
  font-size:14px;font-weight:300;
  text-decoration:none;transition:border-color .2s;
}
.btn-results-ghost:hover{border-color:var(--accent);color:var(--accent)}
/* Rating */
.hero-rating{
  position:absolute;top:76px;right:20px;
  background:rgba(13,15,13,.8);
  border:1px solid var(--border);border-radius:8px;
  padding:14px 18px;text-align:center;z-index:2;
  animation:liftIn .5s .9s ease both;
  backdrop-filter:blur(8px);
}
.rating-num{
  font-family:var(--font-display);
  font-size:30px;font-weight:800;
  color:var(--accent);line-height:1;
}
.rating-stars{color:var(--accent);font-size:11px;margin:4px 0;letter-spacing:1px}
.rating-count{font-size:10px;color:var(--muted);letter-spacing:.5px}

/* ── STATS BAR ──────────────────────────────── */
.stats-bar{
  background:var(--primary);
  padding:20px 28px;
  display:flex;align-items:center;
  justify-content:center;gap:0;flex-wrap:wrap;
}
.stat-item{
  display:flex;flex-direction:column;align-items:center;
  padding:0 32px;border-right:1px solid rgba(255,255,255,.2);
}
.stat-item:last-child{border-right:none}
.stat-num{
  font-family:var(--font-display);
  font-size:28px;font-weight:800;
  color:var(--text);line-height:1;
}
.stat-label{
  font-size:11px;font-weight:400;
  color:rgba(255,255,255,.6);letter-spacing:1px;
  text-transform:uppercase;margin-top:4px;
}

/* ── PROCESS — the journey ─────────────────── */
.process{
  background:var(--dark2);
  padding:96px 28px;
}
.process-inner{max-width:680px;margin:0 auto}
.section-label{
  font-family:var(--font-display);
  font-size:10px;font-weight:600;
  letter-spacing:4px;text-transform:uppercase;
  color:var(--accent);margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .4s ease,transform .4s ease;
}
.section-label.visible{opacity:1;transform:none}
.section-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,44px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
  margin-bottom:48px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s .05s ease,transform .5s .05s ease;
}
.section-headline.visible{opacity:1;transform:none}
.section-headline em{color:var(--accent);font-style:normal}
.process-step{
  display:grid;grid-template-columns:56px 1fr;
  gap:20px;align-items:start;
  padding:28px 0;
  border-bottom:1px solid var(--border);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.process-step:last-child{border-bottom:none}
.process-step.visible{opacity:1;transform:none}
.step-num{
  font-family:var(--font-display);
  font-size:13px;font-weight:700;
  color:var(--accent);letter-spacing:1px;
  padding-top:4px;
}
.step-title{
  font-family:var(--font-display);
  font-size:clamp(18px,4vw,24px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--text);
  margin-bottom:8px;
}
.step-body{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.7;
}

/* ── SERVICES ──────────────────────────────── */
.services{
  background:var(--surface);
  padding:96px 28px;
}
.services-inner{max-width:680px;margin:0 auto}
.service-tile{
  display:flex;align-items:flex-start;gap:16px;
  padding:24px 0;
  border-bottom:1px solid var(--border);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.service-tile:last-child{border-bottom:none}
.service-tile.visible{opacity:1;transform:none}
.service-accent{
  width:3px;height:100%;min-height:40px;
  background:var(--accent);border-radius:2px;
  flex-shrink:0;margin-top:3px;
}
.service-name{
  font-family:var(--font-display);
  font-size:clamp(18px,4vw,22px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--text);
  margin-bottom:4px;
}
.service-desc{
  font-size:13px;font-weight:300;
  color:var(--muted);line-height:1.6;
}

/* ── ABOUT ──────────────────────────────────── */
.about{
  background:var(--dark);
  padding:96px 28px;position:relative;overflow:hidden;
}
/* Diagonal line texture */
.about::before{
  content:'';position:absolute;inset:0;
  background:repeating-linear-gradient(
    -45deg,
    transparent,transparent 40px,
    rgba(255,255,255,.01) 40px,rgba(255,255,255,.01) 41px
  );pointer-events:none;
}
.about-inner{position:relative;z-index:2;max-width:680px;margin:0 auto}
.about-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,44px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
  margin-bottom:24px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{color:var(--accent);font-style:normal}
.about-pull{
  font-size:18px;font-weight:300;
  color:rgba(255,255,255,.8);line-height:1.6;
  border-left:3px solid var(--accent);
  padding-left:20px;margin-bottom:28px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.about-pull.visible{opacity:1;transform:none}
.about-body{
  font-size:15px;font-weight:300;
  color:var(--muted);line-height:1.8;margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .15s ease,transform .5s .15s ease;
}
.about-body.visible{opacity:1;transform:none}

/* ── GALLERY — the proof ────────────────────── */
.gallery{
  background:var(--dark2);
  padding:80px 0;
}
.gallery-header{
  padding:0 28px 40px;
  opacity:0;transform:translateY(12px);
  transition:opacity .5s ease,transform .5s ease;
}
.gallery-header.visible{opacity:1;transform:none}
.gallery-title{
  font-family:var(--font-display);
  font-size:clamp(24px,5vw,36px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
}
.gallery-subtitle{
  font-size:14px;font-weight:300;
  color:var(--muted);margin-top:6px;
}
/* Gallery carousel */
.gallery-carousel{overflow:hidden}
.gallery-track{display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;-ms-overflow-style:none;padding:0 28px 20px}
.gallery-track::-webkit-scrollbar{display:none}
.gallery-slide{flex-shrink:0;width:80vw;max-width:360px;scroll-snap-align:start}
.gallery-img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:20px;display:block;opacity:0;transition:opacity .6s ease}
.gallery-img.visible{opacity:1}
.gallery-dots{display:flex;justify-content:center;gap:6px;padding-top:4px}
.gallery-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.25);transition:background .3s,width .3s}
.gallery-dot.active{width:20px;border-radius:3px;background:var(--accent)}

/* ── REVIEWS ──────────────────────────────────── */
.reviews{
  background:var(--surface);
  padding:96px 28px;
}
.reviews-inner{max-width:680px;margin:0 auto}
.reviews-header{
  display:flex;align-items:flex-end;
  justify-content:space-between;
  margin-bottom:48px;flex-wrap:wrap;gap:16px;
}
.reviews-title{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,40px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
}
.reviews-title em{color:var(--accent);font-style:normal}
.review-block{
  padding:32px 0;
  border-bottom:1px solid var(--border);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.review-block:last-child{border-bottom:none}
.review-block.visible{opacity:1;transform:none}
.review-text{
  font-size:16px;font-weight:300;
  color:rgba(255,255,255,.85);line-height:1.7;
  margin-bottom:16px;
}
.review-text::before{
  content:'"';font-family:var(--font-display);
  font-size:40px;font-weight:800;
  color:var(--accent);line-height:0;
  vertical-align:-.4em;margin-right:4px;
}
.review-meta{
  display:flex;align-items:center;gap:12px;
  font-size:11px;font-weight:500;
  letter-spacing:1.5px;text-transform:uppercase;
}
.review-stars{color:var(--accent)}
.review-name{color:var(--muted)}

/* ── TESTIMONIAL — the emotional peak ─────── */
.testimonial{
  background:var(--dark);
  padding:120px 28px;
  text-align:center;position:relative;overflow:hidden;
}
/* Large quote mark background */
.testimonial::before{
  content:'"';
  position:absolute;top:-60px;left:50%;
  transform:translateX(-50%);
  font-family:var(--font-display);
  font-size:400px;font-weight:800;
  color:rgba(255,255,255,.02);
  line-height:1;pointer-events:none;user-select:none;
}
.testimonial-inner{
  position:relative;z-index:2;
  max-width:600px;margin:0 auto;
  opacity:0;transform:translateY(20px);
  transition:opacity .8s ease,transform .8s ease;
}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{
  font-family:var(--font-display);
  font-size:clamp(22px,5vw,34px);
  font-weight:400;color:var(--text);
  line-height:1.4;margin-bottom:36px;
}
.testimonial-accent-line{
  width:40px;height:2px;
  background:var(--accent);
  margin:0 auto 20px;
}
.testimonial-name{
  font-family:var(--font-display);
  font-size:12px;font-weight:700;
  letter-spacing:3px;text-transform:uppercase;
  color:var(--accent);
}
.testimonial-context{
  font-size:12px;font-weight:300;
  color:var(--muted);margin-top:4px;
}

/* ── WHY US ──────────────────────────────────── */
.whyus{
  background:var(--dark2);
  padding:96px 28px;
}
.whyus-inner{max-width:680px;margin:0 auto}
.diff-item{
  padding:28px 0;
  border-bottom:1px solid var(--border);
  opacity:0;transform:translateY(10px);
  transition:opacity .4s ease,transform .4s ease;
}
.diff-item:last-child{border-bottom:none}
.diff-item.visible{opacity:1;transform:none}
.diff-num{
  font-family:var(--font-display);
  font-size:10px;font-weight:700;
  letter-spacing:3px;color:var(--accent);
  margin-bottom:6px;text-transform:uppercase;
}
.diff-title{
  font-family:var(--font-display);
  font-size:clamp(18px,4vw,24px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--text);
  margin-bottom:8px;
}
.diff-body{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.7;
}

/* ── CONTACT ──────────────────────────────────── */
.contact{
  background:var(--surface);
  padding:96px 28px;
}
.contact-inner{max-width:680px;margin:0 auto}
.contact-headline{
  font-family:var(--font-display);
  font-size:clamp(32px,7vw,52px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
  margin-bottom:12px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{color:var(--accent);font-style:normal}
.contact-promise{
  font-size:16px;font-weight:300;
  color:var(--muted);line-height:1.6;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.contact-promise.visible{opacity:1;transform:none}
.contact-actions{
  display:flex;gap:12px;flex-wrap:wrap;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .2s ease,transform .5s .2s ease;
}
.contact-actions.visible{opacity:1;transform:none}
.btn-contact-primary{
  background:var(--primary);color:var(--text);
  padding:16px 28px;border-radius:6px;
  font-size:15px;font-weight:500;
  text-decoration:none;display:flex;
  align-items:center;gap:8px;
  transition:opacity .2s;
}
.btn-contact-primary:hover{opacity:.9}
.btn-contact-secondary{
  border:1px solid var(--border);color:var(--text);
  padding:15px 28px;border-radius:6px;
  font-size:14px;font-weight:300;
  text-decoration:none;display:flex;
  align-items:center;gap:8px;
  transition:border-color .2s;
}
.btn-contact-secondary:hover{border-color:var(--accent);color:var(--accent)}
.contact-details{display:flex;flex-direction:column;gap:12px}
.contact-detail{
  display:flex;align-items:flex-start;gap:16px;
  padding:18px;background:var(--dark2);
  border-radius:8px;border-left:3px solid var(--accent);
  opacity:0;transform:translateY(8px);
  transition:opacity .3s ease,transform .3s ease;
}
.contact-detail.visible{opacity:1;transform:none}
.contact-detail-icon{font-size:18px;flex-shrink:0;margin-top:2px}
.contact-detail-label{
  font-size:10px;font-weight:600;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--accent);margin-bottom:4px;
}
.contact-detail-value{
  font-size:15px;font-weight:300;
  color:var(--text);line-height:1.5;
}
.contact-detail-link{color:var(--accent);text-decoration:none}
.hours-row{font-size:13px;color:var(--text);padding:2px 0}

/* ── FOOTER ──────────────────────────────────── */
.footer{
  background:var(--dark);
  border-top:1px solid var(--border);
  padding:48px 28px;text-align:center;
}
.footer-brand{
  font-family:var(--font-display);
  font-size:18px;font-weight:700;
  text-transform:uppercase;letter-spacing:1px;
  color:var(--text);margin-bottom:6px;
}
.footer-tagline{
  font-size:12px;font-weight:300;
  color:var(--muted);margin-bottom:24px;
}
.footer-links{
  display:flex;justify-content:center;
  gap:20px;flex-wrap:wrap;margin-bottom:20px;
}
.footer-link{
  font-size:12px;color:rgba(255,255,255,.3);
  text-decoration:none;letter-spacing:.3px;
  transition:color .2s;
}
.footer-link:hover{color:var(--accent)}
.footer-copy{font-size:11px;color:rgba(255,255,255,.15)}

/* ── FLOATING WA ──────────────────────────── */
/* Dual FAB — WhatsApp + Call */
.fab-stack{position:fixed;bottom:24px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:999}
.fab-btn{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.25);text-decoration:none;font-size:22px;transition:transform .2s,box-shadow .2s}
.fab-btn:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,.35)}
.fab-wa{background:#25D366}
.fab-call{background:#007AFF}

/* ── ANIMATIONS ──────────────────────────────── */
@keyframes heroLift{from{transform:scale(1.05)}to{transform:scale(1)}}
@keyframes liftIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@keyframes revealLine{from{transform:scaleX(0);opacity:0}to{transform:scaleX(1);opacity:1}}
</style>
</head>
<body>

<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="nav-links">
    <a href="#process" class="nav-link">How we work</a>
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Reviews</a>` : ''}
    <a href="#contact" class="nav-link">Contact</a>
    <a href="${esc(waLink)}" class="nav-link nav-cta">Get a quote</a>
  </div>
</nav>

<section class="hero">
  <div class="hero-bg"></div>
  <div class="hero-reveal-line"></div>
  ${rating ? `
  <div class="hero-rating">
    <div class="rating-num">${rating}</div>
    <div class="rating-stars">${'★'.repeat(Math.round(rating))}</div>
    <div class="rating-count">${reviewCount} reviews</div>
  </div>` : ''}
  <div class="hero-content">
    <div class="hero-category">
      <div class="category-bar"></div>
      <div class="category-text">${esc(client.area || domain)}</div>
    </div>
    <h1 class="hero-h1">
      ${esc(t.hero_h1_line1 || '')}
      ${t.hero_h1_line2 ? `<em>${esc(t.hero_h1_line2)}</em>` : ''}
    </h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-ctas">
      <a href="${esc(waLink)}" class="btn-results-primary">💬 Get a free quote</a>
      <a href="#process" class="btn-results-ghost">How we work ↓</a>
    </div>
  </div>
</section>

<!-- Stats bar -->
<div class="stats-bar">
  <div class="stat-item">
    <div class="stat-num">100%</div>
    <div class="stat-label">Satisfaction</div>
  </div>
  <div class="stat-item">
    <div class="stat-num">Free</div>
    <div class="stat-label">Site Visit</div>
  </div>
  ${rating ? `
  <div class="stat-item">
    <div class="stat-num">${rating}★</div>
    <div class="stat-label">Google Rating</div>
  </div>` : ''}
  <div class="stat-item">
    <div class="stat-num">0</div>
    <div class="stat-label">Surprises</div>
  </div>
</div>

<!-- Process -->
<section class="process" id="process">
  <div class="process-inner">
    <div class="section-label">${esc(t.section_label_services || 'HOW WE WORK')}</div>
    <h2 class="section-headline">From <em>quote to done</em></h2>
    ${processSteps.map((s,i) => `
    <div class="process-step" style="transition-delay:${i*.08}s">
      <div class="step-num">${s.num}</div>
      <div>
        <div class="step-title">${esc(s.title)}</div>
        <div class="step-body">${esc(s.body)}</div>
      </div>
    </div>`).join('')}
  </div>
</section>

<!-- Services -->
<section class="services" id="services">
  <div class="services-inner">
    <div class="section-label">${esc(t.section_label_services || 'WHAT WE DO')}</div>
    <h2 class="section-headline">${esc(t.services_headline || '')}</h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-tile" style="transition-delay:${i*.07}s">
      <div class="service-accent"></div>
      <div>
        <div class="service-name">${esc(s.name || '')}</div>
        ${!isExp && s.desc ? `<div class="service-desc">${esc(s.desc)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>
</section>

${!isExp ? `
<!-- About -->
<section class="about" id="about">
  <div class="about-inner">
    <div class="section-label">${esc(t.section_label_about || 'WHO WE ARE')}</div>
    <h2 class="about-headline">${esc(t.about_headline || '')}</h2>
    <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    <p class="about-body">${esc(t.about_p1 || '')}</p>
    ${t.about_p2 ? `<p class="about-body" style="transition-delay:.2s">${esc(t.about_p2)}</p>` : ''}
  </div>
</section>` : ''}

${galleryPhotos.length ? `
<!-- Gallery -->
<section class="gallery" id="gallery">
  <div class="gallery-header">
    <div class="section-label">OUR WORK</div>
    <div class="gallery-title">See what we can do</div>
    <div class="gallery-subtitle">Every job finished to the same standard. No exceptions.</div>
  </div>
  <div class="gallery-carousel">
    <div class="gallery-track" id="galleryTrack">
      ${galleryPhotos.map((url,i) => `<div class="gallery-slide"><img class="gallery-img" src="${esc(url)}" alt="${esc(client.business_name)}" loading="lazy"></div>`).join('')}
    </div>
    <div class="gallery-dots" id="galleryDots">
      ${galleryPhotos.map((_,i) => `<div class="gallery-dot${i===0?' active':''}" data-idx="${i}"></div>`).join('')}
    </div>
  </div>
</section>` : ''}

${reviews.length && !isExp ? `
<!-- Reviews -->
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <h2 class="reviews-title">THE <em>PROOF</em></h2>
      ${rating ? `
      <div style="text-align:right">
        <div style="font-family:var(--font-display);font-size:44px;font-weight:800;color:var(--accent);line-height:1">${rating}</div>
        <div style="color:var(--accent);font-size:13px;letter-spacing:2px">${'★'.repeat(Math.round(rating))}</div>
        <div style="font-size:11px;color:var(--muted);letter-spacing:1px;margin-top:4px">${reviewCount} REVIEWS</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-block" style="transition-delay:${i*.1}s">
      <p class="review-text">${esc(r.text || '')}</p>
      <div class="review-meta">
        <span class="review-stars">${'★'.repeat(r.rating || 5)}</span>
        <span class="review-name">${esc(r.author || '')}</span>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${t.testimonial_quote && !isExp ? `
<!-- Testimonial -->
<section class="testimonial">
  <div class="testimonial-inner">
    <p class="testimonial-quote">${esc(t.testimonial_quote)}</p>
    <div class="testimonial-accent-line"></div>
    <div class="testimonial-name">${esc(t.testimonial_name || '')}</div>
    <div class="testimonial-context">${esc(t.testimonial_context || '')}</div>
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<!-- Why Us -->
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-label">${esc(t.section_label_whyus || 'WHY US')}</div>
    <h2 class="section-headline">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-item" style="transition-delay:${i*.08}s">
      <div class="diff-num">0${i+1}</div>
      <div class="diff-title">${esc(d.title)}</div>
      <div class="diff-body">${esc(d.body || '')}</div>
    </div>`).join('')}
  </div>
</section>` : ''}

<!-- Contact -->
<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="section-label">${esc(t.section_label_contact || 'GET IN TOUCH')}</div>
    <h2 class="contact-headline">See what we can <em>do for you</em></h2>
    <p class="contact-promise">${esc(t.contact_subline || 'We don\'t finish until you love it. That\'s not a slogan — it\'s how we work.')}</p>
    <div class="contact-actions">
      <a href="${esc(waLink)}" class="btn-contact-primary">💬 ${esc(t.contact_cta || 'Get a free quote')}</a>
      <a href="${esc(callLink)}" class="btn-contact-secondary">📞 ${phoneDisplay || esc(client.phone || 'Call us')}</a>
    </div>
    <div class="contact-details">
      ${client.phone ? `
      <div class="contact-detail">
        <div class="contact-detail-icon">📞</div>
        <div>
          <div class="contact-detail-label">Call us</div>
          <a href="${esc(callLink)}" class="contact-detail-value contact-detail-link">${phoneDisplay}</a>
        </div>
      </div>` : ''}
      ${address ? `
      <div class="contact-detail" style="transition-delay:.1s">
        <div class="contact-detail-icon">📍</div>
        <div>
          <div class="contact-detail-label">Find us</div>
          <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="contact-detail-value contact-detail-link">${esc(address)}</a>
        </div>
      </div>` : ''}
      ${hours.length ? `
      <div class="contact-detail" style="transition-delay:.2s">
        <div class="contact-detail-icon">🕐</div>
        <div>
          <div class="contact-detail-label">Hours</div>
          <div>${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
        </div>
      </div>` : ''}
    </div>
  </div>
</section>

<footer class="footer">
  <div class="footer-brand">${esc(t.short_name || client.business_name)}</div>
  <div class="footer-tagline">We don't finish until you love it.</div>
  <div class="footer-links">
    <a href="${esc(waLink)}" class="footer-link">WhatsApp</a>
    ${client.instagram ? `<a href="https://instagram.com/${esc((client.instagram||'').replace('@',''))}" class="footer-link" target="_blank">Instagram</a>` : ''}
    ${client.facebook ? `<a href="https://facebook.com/${esc(client.facebook||'')}" class="footer-link" target="_blank">Facebook</a>` : ''}
    <a href="#" class="footer-link">Back to top ↑</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} ${esc(client.business_name)} · ${esc(domain)}</div>
</footer>

${esc(phone) ? `<div class="fab-stack"><a href="tel:${esc(phone)}" class="fab-btn fab-call" aria-label="Call">📞</a><a href="${esc(waLink)}" class="fab-btn fab-wa" aria-label="WhatsApp">💬</a></div>` : `<a href="${esc(waLink)}" class="fab-btn fab-wa" style="position:fixed;bottom:24px;right:20px;z-index:999" aria-label="WhatsApp">💬</a>`}

<script>
const nav=document.getElementById('nav');
window.addEventListener('scroll',()=>{nav.classList.toggle('scrolled',window.scrollY>60)},{passive:true});

const obs=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target)}});
},{threshold:0.12,rootMargin:'0px 0px -32px 0px'});

document.querySelectorAll('.section-label,.section-headline,.process-step,.service-tile,.about-headline,.about-pull,.about-body,.gallery-header,.gallery-img,.review-block,.testimonial-inner,.diff-item,.contact-headline,.contact-promise,.contact-actions,.contact-detail').forEach(el=>obs.observe(el));

// Gallery carousel
const gTrack=document.getElementById('galleryTrack');
const gDots=document.querySelectorAll('.gallery-dot');
if(gTrack&&gDots.length){
  gTrack.addEventListener('scroll',()=>{
    const idx=Math.round(gTrack.scrollLeft/(gTrack.querySelector('.gallery-slide')?.offsetWidth+16||1));
    gDots.forEach((d,i)=>d.classList.toggle('active',i===idx));
  },{passive:true});
  gDots.forEach((d,i)=>d.addEventListener('click',()=>{
    const slides=gTrack.querySelectorAll('.gallery-slide');
    if(slides[i])slides[i].scrollIntoView({behavior:'smooth',block:'nearest',inline:'start'});
  }));
}

document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{
    const t=document.querySelector(a.getAttribute('href'));
    if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}
  });
});

// Counters
(function(){
  var s='${client.slug}';
  if(!s)return;
  new Image().src='/'+s+'/ping';
  document.querySelectorAll('a[href*="wa.me"]').forEach(function(a){
    a.addEventListener('click',function(){new Image().src='/'+s+'/wa';},{once:true,passive:true});
  });
})();
</script>
</body>
</html>`;
}
