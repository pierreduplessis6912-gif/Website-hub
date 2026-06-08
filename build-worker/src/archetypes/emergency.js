/**
 * EMERGENCY ARCHETYPE — The Man Who Shows Up
 *
 * For: plumber, electrician, locksmith, HVAC, handyman, appliance repair,
 *      pest control, security, towing, roofing, waterproofing, welding,
 *      gates, solar installation, pool service, fire protection
 *
 * Feel: Dark workshop. Sawdust in the air. The smell of hard work.
 *       Tough, quick to act, dependable. Not urgent in a stressful way —
 *       urgent in a "someone has your back" way. The phone number is always
 *       visible. Everything snaps into place. No slow fades.
 *       The tools are the texture. The skill is the story.
 */

export function generateEmergencyHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone   = (client.phone || '').replace(/\D/g, '');
  const domain  = client.domain || `${client.slug}.co.za`;
  const waLink  = `https://wa.me/${phone}`;
  const callLink = `tel:${client.phone || ''}`;
  const isExp   = pkg === 'express';
  const isPrem  = pkg === 'premium';

  const primary = brandBrief?.primary_colour || '#e85d04';
  const accent  = brandBrief?.accent_colour  || '#ffd700';
  const svcs    = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';
  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);

  // Format phone for display — strip country code, add leading zero
  const phoneDisplay = client.phone
    ? client.phone.replace(/^\+?27/, '0').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')
    : '';

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Industry-specific availability line
  const industry = (cards?.industry || client.industry || '').toLowerCase();
  const availability =
    /electric|plumb|lock|geyser|burst|leak/.test(industry) ? '24/7 Emergency Response' :
    /tow|recov/.test(industry)                              ? 'Available Day & Night' :
    /securi|alarm|cctv/.test(industry)                      ? '24/7 Monitoring & Response' :
    'Available When You Need Us';

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
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,400;0,600;0,700;0,800;0,900;1,700&family=Barlow:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --dark:#0a0908;
  --dark2:#111009;
  --steel:#1c1b19;
  --iron:#2a2825;
  --rust:${primary};
  --warm-grey:#8c8880;
  --light:#f0ede8;
  --font-display:'Barlow Condensed',Impact,sans-serif;
  --font-body:'Barlow',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--dark);color:var(--light);overflow-x:hidden}

/* ── GRAIN TEXTURE — over everything ─────── */
body::before{
  content:'';position:fixed;inset:0;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
  pointer-events:none;z-index:999;opacity:.4;
}

/* ── ALWAYS-VISIBLE PHONE STRIP ──────────── */
.phone-strip{
  position:fixed;top:0;left:0;right:0;z-index:200;
  background:var(--rust);
  display:flex;align-items:center;justify-content:center;
  gap:12px;padding:10px 20px;
  font-family:var(--font-display);
  font-size:15px;font-weight:700;letter-spacing:1px;
}
.phone-strip a{color:#000;text-decoration:none;display:flex;align-items:center;gap:8px}
.phone-strip-label{font-size:11px;font-weight:600;letter-spacing:2px;opacity:.7;text-transform:uppercase}

/* ── NAV ──────────────────────────────────── */

.gallery{padding:60px 0;background:var(--bg,#0e0c09)}
.gallery-header{padding:0 24px 28px;text-align:center}
.gallery-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:.5;margin-bottom:8px}
.gallery-title{font-size:26px;font-weight:700;margin-bottom:6px}
.gallery-subtitle{font-size:14px;opacity:.6}
.gallery-track{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:0 24px 16px}
.gallery-track::-webkit-scrollbar{display:none}
.gallery-slide{flex:0 0 72vw;max-width:280px;scroll-snap-align:start;border-radius:14px;overflow:hidden;aspect-ratio:4/3}
.gallery-img{width:100%;height:100%;object-fit:cover;display:block}


.map-section{padding:0}
.map-embed{width:100%;height:220px;border:none;display:block;filter:grayscale(20%)}

.nav{
  position:fixed;top:40px;left:0;right:0;z-index:100;
  display:flex;align-items:center;justify-content:space-between;
  padding:16px 24px;
  background:transparent;
  transition:background .3s;
}
.nav.scrolled{background:rgba(10,9,8,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.nav-brand{
  font-family:var(--font-display);
  font-size:20px;font-weight:800;letter-spacing:1px;
  color:var(--light);text-decoration:none;text-transform:uppercase;
}
.nav-links{display:flex;align-items:center;gap:14px;flex-shrink:0}
.nav-link{
  color:rgba(255,255,255,.7);font-size:13px;font-weight:500;
  letter-spacing:.5px;text-decoration:none;text-transform:uppercase;
  transition:color .15s;
}
.nav-link:hover{color:var(--rust)}
.nav-call{
  display:block!important;white-space:nowrap;
  background:var(--rust);color:#000!important;
  padding:8px 16px;font-weight:700;letter-spacing:.5px;
  border-radius:4px;transition:opacity .15s;
}
.nav-call:hover{opacity:.85}

/* ── HERO ──────────────────────────────────── */
.hero{
  position:relative;
  min-height:100svh;padding-top:90px;
  display:flex;flex-direction:column;
  justify-content:flex-end;
  padding-bottom:60px;padding-left:24px;padding-right:24px;
  overflow:hidden;
}
.hero-bg{
  position:absolute;inset:0;
  background-image:url('${esc(heroUrl)}');
  background-size:cover;background-position:center;
  animation:heroSnap .4s cubic-bezier(.16,1,.3,1) both;
}
/* Heavy dark overlay — this is a workshop, not a gallery */
.hero-bg::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(
    160deg,
    rgba(10,9,8,.85) 0%,
    rgba(10,9,8,.6) 50%,
    rgba(10,9,8,.9) 100%
  );
}
/* Tool silhouette watermark */
.hero-watermark{
  position:absolute;right:-40px;top:50%;
  transform:translateY(-50%);
  opacity:.04;pointer-events:none;
  width:60vw;max-width:320px;
}
.hero-content{position:relative;z-index:2}
.hero-availability{
  display:inline-flex;align-items:center;gap:8px;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);
  border-radius:3px;padding:6px 12px;
  font-size:11px;font-weight:700;letter-spacing:2px;
  text-transform:uppercase;color:var(--accent);
  margin-bottom:20px;
  animation:snapIn .3s .2s ease both;
}
.hero-availability::before{
  content:'';width:7px;height:7px;border-radius:50%;
  background:var(--accent);
  animation:pulse 1.5s infinite;
  flex-shrink:0;
}
.hero-h1{
  font-family:var(--font-display);
  font-size:clamp(60px,16vw,110px);
  font-weight:900;line-height:.92;
  letter-spacing:-1px;
  text-transform:uppercase;
  color:var(--light);
  margin-bottom:20px;
  animation:snapIn .3s .3s ease both;
}
.hero-h1 em{
  font-style:italic;color:var(--rust);
  display:block;
}
.hero-subline{
  font-size:16px;font-weight:400;
  color:rgba(255,255,255,.7);
  line-height:1.6;max-width:480px;
  margin-bottom:32px;
  animation:snapIn .3s .4s ease both;
}
.hero-ctas{
  display:flex;gap:12px;flex-wrap:wrap;
  animation:snapIn .3s .5s ease both;
}
.btn-call{
  background:var(--rust);color:#000;
  padding:16px 28px;border-radius:4px;
  font-family:var(--font-display);
  font-size:16px;font-weight:800;letter-spacing:1px;
  text-decoration:none;text-transform:uppercase;
  display:inline-flex;align-items:center;gap:10px;
  transition:transform .15s,opacity .15s;
}
.btn-call:hover{transform:translateY(-1px)}
.btn-wa{
  border:2px solid rgba(255,255,255,.3);
  color:var(--light);
  padding:16px 28px;border-radius:4px;
  font-family:var(--font-display);
  font-size:15px;font-weight:700;letter-spacing:.5px;
  text-decoration:none;text-transform:uppercase;
  transition:all .15s;
}
.btn-wa:hover{border-color:var(--rust);color:var(--rust)}

/* Rating stamp */
.hero-stamp{
  position:absolute;bottom:140px;right:24px;
  border:2px solid var(--rust);
  border-radius:4px;padding:12px;
  text-align:center;z-index:2;
  animation:snapIn .3s .8s ease both;
  background:rgba(10,9,8,.7);
  backdrop-filter:blur(4px);
  min-width:72px;
}
.stamp-rating{
  font-family:var(--font-display);
  font-size:32px;font-weight:900;
  color:var(--rust);line-height:1;
}
.stamp-stars{color:var(--accent);font-size:11px;margin:3px 0}
.stamp-count{font-size:10px;color:rgba(255,255,255,.5);letter-spacing:.5px}

/* ── TRUST BAR ──────────────────────────────── */
.trust-bar{
  background:var(--rust);
  padding:16px 24px;
  display:flex;align-items:center;justify-content:center;
  gap:32px;flex-wrap:wrap;
}
.trust-item{
  display:flex;align-items:center;gap:8px;
  font-family:var(--font-display);
  font-size:13px;font-weight:700;
  letter-spacing:1px;text-transform:uppercase;color:#000;
}
.trust-item::before{content:'✓';font-size:14px}

/* ── SERVICES ──────────────────────────────── */
.services{
  background:var(--dark2);
  padding:80px 24px;
}
.services-inner{max-width:680px;margin:0 auto}
.section-eyebrow{
  font-size:10px;font-weight:700;letter-spacing:4px;
  text-transform:uppercase;color:var(--rust);
  margin-bottom:16px;
  opacity:0;transform:translateX(-12px);
  transition:opacity .3s ease,transform .3s ease;
}
.section-eyebrow.visible{opacity:1;transform:none}
.section-h1{
  font-family:var(--font-display);
  font-size:clamp(36px,9vw,64px);
  font-weight:900;line-height:.95;
  text-transform:uppercase;letter-spacing:-1px;
  color:var(--light);margin-bottom:40px;
  opacity:0;transform:translateX(-16px);
  transition:opacity .35s .05s ease,transform .35s .05s ease;
}
.section-h1.visible{opacity:1;transform:none}
.section-h1 em{font-style:italic;color:var(--rust)}
.service-row{
  display:flex;align-items:flex-start;gap:20px;
  padding:24px 0;border-bottom:1px solid rgba(255,255,255,.07);
  opacity:0;transform:translateX(-12px);
  transition:opacity .3s ease,transform .3s ease;
}
.service-row:last-child{border-bottom:none}
.service-row.visible{opacity:1;transform:none}
.service-num{
  font-family:var(--font-display);
  font-size:13px;font-weight:700;
  color:var(--rust);letter-spacing:1px;
  min-width:28px;margin-top:3px;
}
.service-name{
  font-family:var(--font-display);
  font-size:clamp(20px,5vw,28px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--light);
  margin-bottom:4px;
}
.service-desc{
  font-size:14px;font-weight:300;
  color:var(--warm-grey);line-height:1.5;
}

/* ── ABOUT ──────────────────────────────────── */
.about{
  background:var(--steel);
  padding:80px 24px;position:relative;overflow:hidden;
}
/* Concrete texture overlay */
.about::before{
  content:'';position:absolute;inset:0;
  background:repeating-linear-gradient(
    0deg,
    transparent,transparent 2px,
    rgba(255,255,255,.015) 2px,rgba(255,255,255,.015) 3px
  );pointer-events:none;
}
.about-inner{position:relative;z-index:2;max-width:680px;margin:0 auto}
.about-headline{
  font-family:var(--font-display);
  font-size:clamp(32px,8vw,56px);
  font-weight:900;text-transform:uppercase;
  letter-spacing:-1px;line-height:.95;
  color:var(--light);margin-bottom:24px;
  opacity:0;transform:translateY(16px);
  transition:opacity .35s ease,transform .35s ease;
}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{display:block;font-style:italic;color:var(--rust)}
.about-pull{
  font-size:18px;font-weight:400;
  color:rgba(255,255,255,.8);line-height:1.6;
  border-left:3px solid var(--rust);
  padding-left:20px;margin-bottom:24px;
  opacity:0;transform:translateY(12px);
  transition:opacity .35s .1s ease,transform .35s .1s ease;
}
.about-pull.visible{opacity:1;transform:none}
.about-body{
  font-size:15px;font-weight:300;
  color:var(--warm-grey);line-height:1.8;
  margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .35s .2s ease,transform .35s .2s ease;
}
.about-body.visible{opacity:1;transform:none}

/* ── WHY US ──────────────────────────────────── */
.whyus{
  background:var(--dark);
  padding:80px 24px;
}
.whyus-inner{max-width:680px;margin:0 auto}
.diff-block{
  padding:28px 0;
  border-bottom:1px solid rgba(255,255,255,.07);
  opacity:0;transform:translateY(12px);
  transition:opacity .3s ease,transform .3s ease;
}
.diff-block:last-child{border-bottom:none}
.diff-block.visible{opacity:1;transform:none}
.diff-num{
  font-family:var(--font-display);
  font-size:11px;font-weight:700;
  letter-spacing:3px;color:var(--rust);
  margin-bottom:6px;text-transform:uppercase;
}
.diff-title{
  font-family:var(--font-display);
  font-size:clamp(22px,5vw,32px);
  font-weight:800;text-transform:uppercase;
  letter-spacing:.5px;color:var(--light);
  margin-bottom:8px;
}
.diff-body{
  font-size:14px;font-weight:300;
  color:var(--warm-grey);line-height:1.7;
}

/* ── REVIEWS ──────────────────────────────────── */
.reviews{
  background:var(--iron);
  padding:80px 24px;
}
.reviews-inner{max-width:680px;margin:0 auto}
.reviews-header{
  display:flex;align-items:flex-end;
  justify-content:space-between;
  margin-bottom:48px;flex-wrap:wrap;gap:16px;
}
.reviews-title{
  font-family:var(--font-display);
  font-size:clamp(32px,8vw,52px);
  font-weight:900;text-transform:uppercase;
  letter-spacing:-1px;color:var(--light);line-height:.95;
}
.reviews-title em{font-style:italic;color:var(--rust)}
.review-block{
  padding:32px 0;border-bottom:1px solid rgba(255,255,255,.07);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.review-block:last-child{border-bottom:none}
.review-block.visible{opacity:1;transform:none}
.review-text{
  font-size:16px;font-weight:400;
  color:rgba(255,255,255,.85);line-height:1.7;
  margin-bottom:16px;
}
.review-text::before{
  content:'"';
  font-family:var(--font-display);
  font-size:48px;font-weight:900;
  color:var(--rust);line-height:0;
  vertical-align:-.5em;margin-right:4px;
}
.review-meta{
  display:flex;align-items:center;gap:12px;
  font-size:11px;font-weight:700;
  letter-spacing:2px;text-transform:uppercase;
}
.review-stars{color:var(--accent)}
.review-name{color:var(--rust)}

/* ── TESTIMONIAL ──────────────────────────────── */
.testimonial{
  background:var(--rust);
  padding:80px 24px;
  text-align:center;
}
.testimonial-inner{
  max-width:560px;margin:0 auto;
  opacity:0;transform:translateY(16px);
  transition:opacity .5s ease,transform .5s ease;
}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{
  font-family:var(--font-display);
  font-size:clamp(22px,6vw,36px);
  font-weight:800;text-transform:uppercase;
  letter-spacing:-.5px;line-height:1.1;
  color:#000;margin-bottom:24px;
}
.testimonial-attr{
  font-size:12px;font-weight:700;
  letter-spacing:2px;text-transform:uppercase;color:rgba(0,0,0,.6);
}

/* ── CONTACT ──────────────────────────────────── */
.contact{
  background:var(--dark2);
  padding:80px 24px;
}
.contact-inner{max-width:680px;margin:0 auto}
.contact-headline{
  font-family:var(--font-display);
  font-size:clamp(40px,10vw,72px);
  font-weight:900;text-transform:uppercase;
  letter-spacing:-2px;line-height:.9;
  color:var(--light);margin-bottom:8px;
  opacity:0;transform:translateY(16px);
  transition:opacity .35s ease,transform .35s ease;
}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{display:block;font-style:italic;color:var(--rust)}
.contact-subline{
  font-size:16px;font-weight:300;
  color:var(--warm-grey);margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .35s .1s ease,transform .35s .1s ease;
}
.contact-subline.visible{opacity:1;transform:none}
.contact-primary{
  display:flex;flex-direction:column;gap:12px;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .35s .2s ease,transform .35s .2s ease;
}
.contact-primary.visible{opacity:1;transform:none}
.btn-contact-call{
  background:var(--rust);color:#000;
  padding:20px 28px;border-radius:4px;
  font-family:var(--font-display);
  font-size:18px;font-weight:900;letter-spacing:1px;
  text-decoration:none;text-transform:uppercase;
  display:flex;align-items:center;justify-content:center;gap:12px;
  transition:opacity .15s;
}
.btn-contact-call:hover{opacity:.9}
.btn-contact-wa{
  border:2px solid var(--rust);color:var(--rust);
  padding:18px 28px;border-radius:4px;
  font-family:var(--font-display);
  font-size:16px;font-weight:800;letter-spacing:.5px;
  text-decoration:none;text-transform:uppercase;
  display:flex;align-items:center;justify-content:center;gap:10px;
  transition:all .15s;
}
.btn-contact-wa:hover{background:var(--rust);color:#000}
.contact-details{display:flex;flex-direction:column;gap:12px}
.contact-item{
  display:flex;align-items:flex-start;gap:16px;
  padding:18px;background:var(--steel);border-radius:4px;
  border-left:3px solid var(--rust);
  opacity:0;transform:translateY(10px);
  transition:opacity .3s ease,transform .3s ease;
}
.contact-item.visible{opacity:1;transform:none}
.contact-item-icon{font-size:18px;flex-shrink:0;margin-top:2px}
.contact-item-label{
  font-size:10px;font-weight:700;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--rust);margin-bottom:4px;
}
.contact-item-value{
  font-size:15px;font-weight:400;color:var(--light);line-height:1.5;
}
.contact-item-link{color:var(--rust);text-decoration:none}
.hours-row{
  font-size:13px;font-weight:300;color:var(--light);
  padding:2px 0;display:flex;gap:8px;
}

/* ── FOOTER ──────────────────────────────────── */
.footer{
  background:var(--dark);
  border-top:1px solid rgba(255,255,255,.07);
  padding:40px 24px;
  display:flex;flex-direction:column;align-items:center;gap:16px;
  text-align:center;
}
.footer-brand{
  font-family:var(--font-display);
  font-size:20px;font-weight:900;
  letter-spacing:2px;text-transform:uppercase;color:var(--light);
}
.footer-links{display:flex;gap:20px;flex-wrap:wrap;justify-content:center}
.footer-link{
  font-size:11px;font-weight:600;
  letter-spacing:1.5px;text-transform:uppercase;
  color:rgba(255,255,255,.3);text-decoration:none;transition:color .2s;
}
.footer-link:hover{color:var(--rust)}
.footer-copy{font-size:11px;color:rgba(255,255,255,.15)}

/* ── FLOATING CALL BUTTON ──────────────────── */
.call-float{
  position:fixed;bottom:24px;right:24px;z-index:90;
  background:var(--rust);color:#000;
  width:60px;height:60px;border-radius:4px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  font-family:var(--font-display);
  font-size:9px;font-weight:800;letter-spacing:1px;text-transform:uppercase;
  text-decoration:none;gap:2px;
  box-shadow:0 4px 20px rgba(0,0,0,.5);
  transition:transform .15s;
}
.call-float:hover{transform:scale(1.05)}
.call-float-icon{font-size:22px}

/* ── ANIMATIONS ──────────────────────────────── */
@keyframes heroSnap{from{transform:scale(1.03)}to{transform:scale(1)}}
@keyframes snapIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
</style>
</head>
<body>

<!-- Always-visible phone strip -->
<div class="phone-strip">
  <span class="phone-strip-label">${esc(availability)}</span>
  <a href="${esc(callLink)}">📞 ${esc(phoneDisplay || client.phone || '')}</a>
</div>

<!-- Nav -->
<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="nav-links">
    ${!isExp ? `<a href="#about" class="nav-link">About</a>` : ''}
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Reviews</a>` : ''}
    <a href="#contact" class="nav-link">Contact</a>
    <a href="${esc(callLink)}" class="nav-link nav-call">Call Now</a>
  </div>
</nav>

<!-- Hero -->
<section class="hero">
  <div class="hero-bg"></div>
  <!-- Tool silhouette watermark SVG -->
  <svg class="hero-watermark" viewBox="0 0 200 400" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M80 20 L120 20 L130 60 L140 380 L60 380 L70 60 Z" fill="white"/>
    <rect x="60" y="55" width="80" height="12" rx="2" fill="white" opacity=".5"/>
    <rect x="70" y="30" width="60" height="8" rx="2" fill="white" opacity=".3"/>
    <path d="M90 380 L110 380 L115 340 L85 340 Z" fill="white" opacity=".6"/>
  </svg>

  ${rating ? `
  <div class="hero-stamp">
    <div class="stamp-rating">${rating}</div>
    <div class="stamp-stars">${'★'.repeat(Math.round(rating))}</div>
    <div class="stamp-count">${reviewCount} reviews</div>
  </div>` : ''}

  <div class="hero-content">
    <div class="hero-availability">
      <span></span>${esc(availability)}
    </div>
    <h1 class="hero-h1">
      ${esc(t.hero_h1_line1 || '')}
      ${t.hero_h1_line2 ? `<em>${esc(t.hero_h1_line2)}</em>` : ''}
    </h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-ctas">
      <a href="${esc(callLink)}" class="btn-call">📞 Call Now</a>
      <a href="${esc(waLink)}" class="btn-wa">💬 WhatsApp</a>
    </div>
  </div>
</section>

<!-- Trust bar -->
<div class="trust-bar">
  <div class="trust-item">${esc(availability)}</div>
  <div class="trust-item">Free Quote</div>
  <div class="trust-item">Guaranteed Work</div>
  ${gbpData?.payment?.acceptsCreditCards ? `<div class="trust-item">Card Accepted</div>` : ''}
</div>

<!-- Services -->
<section class="services" id="services">
  <div class="services-inner">
    <div class="section-eyebrow">${esc(t.section_label_services || 'WHAT WE DO')}</div>
    <h2 class="section-h1">${esc(t.services_headline || '')}</h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-row" style="transition-delay:${i*.07}s">
      <div class="service-num">0${i+1}</div>
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
    <div class="section-eyebrow">${esc(t.section_label_about || 'WHO WE ARE')}</div>
    <h2 class="about-headline">${esc(t.about_headline || '')}</h2>
    <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    <p class="about-body">${esc(t.about_p1 || '')}</p>
    ${t.about_p2 ? `<p class="about-body" style="transition-delay:.3s">${esc(t.about_p2)}</p>` : ''}
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<!-- Why Us -->
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-eyebrow">${esc(t.section_label_whyus || 'WHY US')}</div>
    <h2 class="section-h1" style="margin-bottom:8px">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-block" style="transition-delay:${i*.08}s">
      <div class="diff-num">0${i+1}</div>
      <div class="diff-title">${esc(d.title)}</div>
      <div class="diff-body">${esc(d.body || '')}</div>
    </div>`).join('')}
  </div>
</section>` : ''}

${reviews.length && !isExp ? `
<!-- Reviews -->
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <h2 class="reviews-title">What they <em>say</em></h2>
      ${rating ? `
      <div style="text-align:right">
        <div style="font-family:var(--font-display);font-size:44px;font-weight:900;color:var(--rust);line-height:1">${rating}</div>
        <div style="color:var(--accent);font-size:14px">${'★'.repeat(Math.round(rating))}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.4);letter-spacing:1px">${reviewCount} REVIEWS</div>
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
    <div class="testimonial-attr">${esc(t.testimonial_name || '')} · ${esc(t.testimonial_context || '')}</div>
  </div>
</section>` : ''}

${galleryPhotos.length ? `
<section style="background:var(--surface);padding:80px 0">
  <div style="padding:0 28px 32px">
    <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:var(--accent);margin-bottom:8px">${esc(t.section_label_gallery || 'OUR WORK')}</div>
    <h2 style="font-size:clamp(28px,6vw,40px);font-weight:800;color:var(--fg);line-height:1.1">See the results</h2>
  </div>
  <div style="overflow:hidden">
    <div id="galleryTrack" style="display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:0 28px 16px">
      ${galleryPhotos.map((url,i) => `<div style="flex-shrink:0;width:78vw;max-width:320px;scroll-snap-align:start"><img src="${esc(url)}" alt="${esc(client.business_name)}" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:16px;display:block" loading="lazy"></div>`).join('')}
    </div>
    <div id="galleryDots" style="display:flex;justify-content:center;gap:6px;padding-bottom:8px">
      ${galleryPhotos.map((_,i) => `<div class="gdot" data-idx="${i}" style="width:${i===0?'20px':'6px'};height:6px;border-radius:3px;background:${i===0?'var(--accent)':'rgba(255,255,255,.2)'};cursor:pointer;transition:all .3s"></div>`).join('')}
    </div>
  </div>
</section>` : ''}

<!-- Contact -->
<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="section-eyebrow">${esc(t.section_label_contact || 'GET IN TOUCH')}</div>
    <h2 class="contact-headline">${esc(t.contact_headline || 'Call us')} <em>${esc(t.contact_subline || 'We answer.')}</em></h2>
    <div class="contact-primary">
      <a href="${esc(callLink)}" class="btn-contact-call">📞 ${esc(client.phone || 'Call Now')}</a>
      <a href="${esc(waLink)}" class="btn-contact-wa">💬 ${esc(t.contact_cta || 'WhatsApp Us')}</a>
    </div>
    <div class="contact-details">
      ${address ? `
      <div class="contact-item">
        <div class="contact-item-icon">📍</div>
        <div>
          <div class="contact-item-label">Find Us</div>
          <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="contact-item-value contact-item-link">${esc(address)}</a>
        </div>
      </div>` : ''}
      ${hours.length ? `
      <div class="contact-item" style="transition-delay:.1s">
        <div class="contact-item-icon">🕐</div>
        <div>
          <div class="contact-item-label">Hours</div>
          <div>${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
        </div>
      </div>` : ''}
      ${gbpData?.payment?.acceptsCreditCards ? `
      <div class="contact-item" style="transition-delay:.2s">
        <div class="contact-item-icon">💳</div>
        <div>
          <div class="contact-item-label">Payment</div>
          <div class="contact-item-value">Card${gbpData.payment.acceptsDebitCards ? ', debit' : ''}, cash accepted</div>
        </div>
      </div>` : ''}
    </div>
  </div>
</section>

<!-- Footer -->

${address ? `
<section class="map-section" id="map">
  <iframe class="map-embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
    src="https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed"
    title="Find us"></iframe>
</section>` : ''}
<footer class="footer">
  <div class="footer-brand">${esc(t.short_name || client.business_name)}</div>
  <div class="footer-links">
    <a href="${esc(callLink)}" class="footer-link">📞 Call</a>
    <a href="${esc(waLink)}" class="footer-link">💬 WhatsApp</a>
    ${client.instagram ? `<a href="https://instagram.com/${esc((client.instagram||'').replace('@',''))}" class="footer-link" target="_blank">Instagram</a>` : ''}
    <a href="#" class="footer-link">Back to top ↑</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} ${esc(client.business_name)} · ${esc(domain)}</div>
</footer>

<!-- Floating call button -->
<a href="${esc(callLink)}" class="call-float" aria-label="Call Now">
  <span class="call-float-icon">📞</span>
  <span>CALL</span>
</a>

<script>

// Licence check — self-hosting protection
(function(){
  var slug = '${esc(client.slug)}';
  var allowed = [slug+'.websitehub.co.za', slug+'.co.za', 'preview.websitehub.co.za', 'localhost', '127.0.0.1'];
  var host = window.location.hostname.toLowerCase();
  if(!allowed.some(function(d){ return host === d || host.endsWith('.'+d); })){
    window.location.replace('https://websitehub.co.za');
  }
})();

// Nav scroll
const nav=document.getElementById('nav');
window.addEventListener('scroll',()=>{nav.classList.toggle('scrolled',window.scrollY>56)},{passive:true});

// Intersection observer — snap in
const obs=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target)}});
},{threshold:0.12,rootMargin:'0px 0px -32px 0px'});

document.querySelectorAll('.section-eyebrow,.section-h1,.service-row,.about-headline,.about-pull,.about-body,.diff-block,.review-block,.testimonial-inner,.contact-headline,.contact-subline,.contact-primary,.contact-item').forEach(el=>obs.observe(el));

// Smooth scroll
document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{
    const t=document.querySelector(a.getAttribute('href'));
    if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}
  });
});

// Gallery carousel
(function(){
  const track=document.getElementById('galleryTrack');
  const dots=document.querySelectorAll('.gdot');
  if(!track||!dots.length)return;
  track.addEventListener('scroll',function(){
    const slide=track.querySelector('div');
    const idx=Math.round(track.scrollLeft/((slide?.offsetWidth||300)+12));
    dots.forEach(function(d,i){
      d.style.width=i===idx?'20px':'6px';
      d.style.background=i===idx?'var(--accent)':'rgba(255,255,255,.2)';
    });
  },{passive:true});
  dots.forEach(function(d,i){
    d.addEventListener('click',function(){
      const slides=track.querySelectorAll(':scope > div');
      if(slides[i])slides[i].scrollIntoView({behavior:'smooth',block:'nearest',inline:'start'});
    });
  });
})();

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

<style>
.fab-stack{position:fixed;bottom:24px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:999}
.fab-btn{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.3);text-decoration:none;font-size:22px;transition:transform .2s}
.fab-btn:hover{transform:scale(1.08)}
.fab-wa{background:#25D366}
.fab-call{background:#007AFF}
</style>

${phone ? `<div class="fab-stack">
  <a href="tel:${esc(phone)}" class="fab-btn fab-call" aria-label="Call">📞</a>
  <a href="${esc(waLink)}" class="fab-btn fab-wa" aria-label="WhatsApp">💬</a>
</div>` : `<a href="${esc(waLink)}" class="fab-btn fab-wa" style="position:fixed;bottom:24px;right:20px;z-index:999" aria-label="WhatsApp">💬</a>`}

</body>
</html>`;
}
