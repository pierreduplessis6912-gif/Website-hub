/**
 * LOCAL ARCHETYPE — The Good Morning Wave
 *
 * For: barber, shisa nyama, spaza, laundry, cleaning, childcare,
 *      driving school, alterations, shoe repair, tuck shop, tavern,
 *      community centre, after school care, garden services, car wash
 *
 * Feel: The barber who knows your no.2 on the sides. The petrol attendant
 *       who washes your window without expecting a tip. Twenty years of
 *       good mornings with people whose names you don't even know.
 *       Warm amber light. Earthy tones. Handmade texture. The neighbourhood
 *       is part of the design. "Pop in and see us." The door is always open.
 */

export function generateLocalHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone       = (client.phone || '').replace(/\D/g, '');
  const domain      = client.domain || `${client.slug}.co.za`;
  const waLink      = `https://wa.me/${phone}`;
  const callLink    = `tel:${client.phone || ''}`;
  const isExp       = pkg === 'express';
  const isPrem      = pkg === 'premium';

  const primary     = brandBrief?.primary_colour || '#d4722a';
  const accent      = brandBrief?.accent_colour  || '#f5c842';
  const svcs        = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';
  const area        = client.area || '';

  const phoneDisplay = (client.phone || '')
    .replace(/^\+?27/, '0')
    .replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Years in business from GBP or default
  const sinceYear = client.since_year || gbpData?.openingDate?.split('-')[0] || null;
  const yearsLine = sinceYear ? `Serving ${esc(area)} since ${sinceYear}` : `Proudly serving ${esc(area)}`;

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
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --warm-dark:#1c1208;
  --brown:#2d1f0e;
  --bark:#4a3520;
  --tan:#c4956a;
  --warm-white:#fdf8f0;
  --cream:#f5ede0;
  --parchment:#efe5d4;
  --muted:#8a7060;
  --font-display:'Fraunces',Georgia,serif;
  --font-body:'DM Sans',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--warm-white);color:var(--warm-dark);overflow-x:hidden}

/* ── HANDMADE TEXTURE — subtle paper grain ── */
body::after{
  content:'';position:fixed;inset:0;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
  pointer-events:none;z-index:998;opacity:1;
}

/* ── NAV ──────────────────────────────────── */
.nav{
  position:fixed;top:0;left:0;right:0;z-index:100;
  display:flex;align-items:center;justify-content:space-between;
  padding:18px 24px;
  background:transparent;
  transition:background .4s;
}
.nav.scrolled{
  background:rgba(253,248,240,.96);
  border-bottom:1px solid var(--parchment);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
}
.nav-brand{
  font-family:var(--font-display);
  font-size:18px;font-weight:400;
  color:var(--warm-dark);text-decoration:none;
}
.nav-links{display:flex;align-items:center;gap:20px}
.nav-link{
  color:var(--muted);font-size:13px;font-weight:400;
  text-decoration:none;transition:color .2s;
}
.nav-link:hover{color:var(--primary)}
.nav-wa{
  background:var(--primary);color:#fff!important;
  padding:9px 18px;border-radius:100px;
  font-weight:500;transition:opacity .2s;
}
.nav-wa:hover{opacity:.9}

/* ── HERO ──────────────────────────────────── */
.hero{
  position:relative;
  height:100svh;min-height:580px;
  display:flex;flex-direction:column;
  justify-content:flex-end;
  padding:0 24px 72px;overflow:hidden;
}
.hero-bg{
  position:absolute;inset:0;
  background-image:url('${esc(heroUrl)}');
  background-size:cover;background-position:center;
  animation:heroReveal 1.2s cubic-bezier(.16,1,.3,1) both;
}
/* Warm amber overlay — feels like golden hour */
.hero-bg::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(
    to bottom,
    rgba(28,18,8,.05) 0%,
    rgba(28,18,8,.15) 40%,
    rgba(28,18,8,.82) 100%
  );
}
/* Hand-drawn underline decoration */
.hero-content{position:relative;z-index:2}
.hero-neighbourhood{
  display:inline-flex;align-items:center;gap:10px;
  margin-bottom:16px;
  animation:driftUp .7s .3s ease both;
}
.neighbourhood-dot{
  width:8px;height:8px;border-radius:50%;
  background:var(--accent);flex-shrink:0;
}
.neighbourhood-text{
  font-size:12px;font-weight:500;letter-spacing:2px;
  text-transform:uppercase;color:var(--accent);
}
.hero-h1{
  font-family:var(--font-display);
  font-size:clamp(44px,12vw,80px);
  font-weight:300;line-height:1.05;
  letter-spacing:-.5px;color:#fff;
  margin-bottom:16px;
  animation:driftUp .7s .4s ease both;
}
.hero-h1 em{font-style:italic;color:var(--accent)}
.hero-subline{
  font-size:16px;font-weight:300;
  color:rgba(255,255,255,.8);line-height:1.6;
  max-width:380px;margin-bottom:32px;
  animation:driftUp .7s .5s ease both;
}
.hero-ctas{
  display:flex;gap:12px;flex-wrap:wrap;
  animation:driftUp .7s .6s ease both;
}
.btn-primary-local{
  background:var(--primary);color:#fff;
  padding:14px 26px;border-radius:100px;
  font-size:14px;font-weight:500;
  text-decoration:none;display:inline-flex;
  align-items:center;gap:8px;
  transition:transform .2s,opacity .2s;
}
.btn-primary-local:hover{transform:translateY(-1px);opacity:.9}
.btn-ghost-local{
  border:1.5px solid rgba(255,255,255,.4);color:#fff;
  padding:14px 26px;border-radius:100px;
  font-size:14px;font-weight:300;
  text-decoration:none;transition:all .2s;
}
.btn-ghost-local:hover{border-color:rgba(255,255,255,.8)}
/* Rating — warm pill */
.hero-rating{
  position:absolute;bottom:140px;right:20px;
  background:rgba(253,248,240,.92);
  border-radius:100px;padding:10px 16px;
  display:flex;align-items:center;gap:10px;
  z-index:2;animation:driftUp .7s 1s ease both;
  backdrop-filter:blur(4px);
}
.rating-num{
  font-family:var(--font-display);
  font-size:22px;font-weight:600;
  color:var(--warm-dark);line-height:1;
}
.rating-stars{color:var(--primary);font-size:12px}
.rating-count{font-size:11px;color:var(--muted)}
/* Scroll nudge */
.scroll-nudge{
  position:absolute;bottom:24px;left:50%;
  transform:translateX(-50%);
  font-size:11px;letter-spacing:2px;
  color:rgba(255,255,255,.4);text-transform:uppercase;
  display:flex;flex-direction:column;align-items:center;gap:6px;
  animation:fadeIn 1s 1.5s ease both;z-index:2;
}
.scroll-nudge-line{
  width:1px;height:32px;
  background:linear-gradient(to bottom,rgba(255,255,255,.4),transparent);
  animation:scrollPulse 2s infinite;
}

/* ── SINCE RIBBON ──────────────────────────── */
.since-ribbon{
  background:var(--primary);
  padding:14px 24px;
  text-align:center;
  font-family:var(--font-display);
  font-size:15px;font-weight:300;font-style:italic;
  color:#fff;letter-spacing:.3px;
}

/* ── ABOUT ──────────────────────────────────── */
.about{
  background:var(--cream);
  padding:88px 24px;position:relative;overflow:hidden;
}
/* Warm geometric shape in background */
.about::before{
  content:'';position:absolute;
  right:-80px;top:-80px;
  width:320px;height:320px;
  border-radius:50%;
  background:var(--parchment);
  opacity:.6;pointer-events:none;
}
.about-inner{position:relative;z-index:2;max-width:620px}
.section-tag{
  font-size:10px;font-weight:500;letter-spacing:3px;
  text-transform:uppercase;color:var(--primary);
  margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s ease,transform .5s ease;
}
.section-tag.visible{opacity:1;transform:none}
.about-headline{
  font-family:var(--font-display);
  font-size:clamp(32px,7vw,52px);
  font-weight:300;line-height:1.15;
  letter-spacing:-.3px;color:var(--warm-dark);
  margin-bottom:24px;
  opacity:0;transform:translateY(14px);
  transition:opacity .6s ease,transform .6s ease;
}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{font-style:italic;color:var(--primary)}
.about-pull{
  font-family:var(--font-display);
  font-size:18px;font-weight:300;font-style:italic;
  color:var(--bark);line-height:1.6;
  padding-left:20px;border-left:2px solid var(--primary);
  margin-bottom:24px;
  opacity:0;transform:translateY(10px);
  transition:opacity .6s .1s ease,transform .6s .1s ease;
}
.about-pull.visible{opacity:1;transform:none}
.about-body{
  font-size:15px;font-weight:300;
  color:var(--muted);line-height:1.8;
  margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .6s .15s ease,transform .6s .15s ease;
}
.about-body.visible{opacity:1;transform:none}

/* ── SERVICES ──────────────────────────────── */
.services{
  background:var(--warm-white);
  padding:88px 24px;
}
.services-inner{max-width:620px;margin:0 auto}
.services-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,44px);
  font-weight:300;line-height:1.15;
  color:var(--warm-dark);margin-bottom:44px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.services-headline.visible{opacity:1;transform:none}
.service-card{
  display:flex;align-items:flex-start;gap:18px;
  padding:24px 0;border-bottom:1px solid var(--parchment);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.service-card:last-child{border-bottom:none}
.service-card.visible{opacity:1;transform:none}
.service-badge{
  width:44px;height:44px;border-radius:50%;
  background:var(--cream);
  display:flex;align-items:center;justify-content:center;
  font-size:20px;flex-shrink:0;
  border:1.5px solid var(--parchment);
}
.service-name{
  font-family:var(--font-display);
  font-size:18px;font-weight:400;
  color:var(--warm-dark);margin-bottom:3px;
}
.service-desc{
  font-size:13px;font-weight:300;
  color:var(--muted);line-height:1.5;
}

/* ── REVIEWS — regulars talking ───────────── */
.reviews{
  background:var(--brown);
  padding:88px 24px;position:relative;overflow:hidden;
}
/* Warm texture circles */
.reviews::before{
  content:'';position:absolute;
  left:-100px;bottom:-100px;
  width:400px;height:400px;
  border-radius:50%;
  border:60px solid rgba(255,255,255,.03);
  pointer-events:none;
}
.reviews::after{
  content:'';position:absolute;
  right:-60px;top:-60px;
  width:240px;height:240px;
  border-radius:50%;
  border:40px solid rgba(255,255,255,.03);
  pointer-events:none;
}
.reviews-inner{position:relative;z-index:2;max-width:620px;margin:0 auto}
.reviews-header{
  margin-bottom:48px;
  display:flex;align-items:flex-end;
  justify-content:space-between;flex-wrap:wrap;gap:16px;
}
.reviews-title{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,44px);
  font-weight:300;color:#fff;line-height:1.15;
}
.reviews-title em{font-style:italic;color:var(--accent)}
.reviews-aggregate{text-align:right}
.reviews-rating-num{
  font-family:var(--font-display);
  font-size:44px;font-weight:300;
  color:var(--accent);line-height:1;
}
.reviews-rating-stars{color:var(--accent);font-size:13px;margin:3px 0}
.reviews-rating-count{font-size:11px;color:rgba(255,255,255,.4);letter-spacing:.5px}
.review-card{
  background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.08);
  border-radius:16px;padding:28px;
  margin-bottom:16px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.review-card:last-child{margin-bottom:0}
.review-card.visible{opacity:1;transform:none}
.review-text{
  font-family:var(--font-display);
  font-size:clamp(16px,3.5vw,20px);
  font-weight:300;font-style:italic;
  color:rgba(255,255,255,.9);line-height:1.6;
  margin-bottom:20px;
}
.review-text::before{
  content:'\u201C';color:var(--accent);
  font-size:1.4em;vertical-align:-.1em;margin-right:4px;
}
.review-footer{
  display:flex;align-items:center;gap:12px;
}
.review-stars{color:var(--accent);font-size:12px}
.review-name{
  font-size:12px;font-weight:500;
  letter-spacing:1px;text-transform:uppercase;
  color:rgba(255,255,255,.5);
}

/* ── WHY US ──────────────────────────────────── */
.whyus{
  background:var(--parchment);
  padding:88px 24px;
}
.whyus-inner{max-width:620px;margin:0 auto}
.diff-row{
  padding:28px 0;
  border-bottom:1px solid rgba(74,53,32,.15);
  display:flex;gap:20px;align-items:flex-start;
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.diff-row:last-child{border-bottom:none}
.diff-row.visible{opacity:1;transform:none}
.diff-icon{
  font-size:24px;flex-shrink:0;
  width:48px;height:48px;background:var(--cream);
  border-radius:50%;display:flex;
  align-items:center;justify-content:center;
  border:1.5px solid rgba(74,53,32,.1);
}
.diff-title{
  font-family:var(--font-display);
  font-size:20px;font-weight:400;
  color:var(--warm-dark);margin-bottom:6px;
}
.diff-body{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.7;
}

/* ── TESTIMONIAL ──────────────────────────────── */
.testimonial{
  background:var(--primary);
  padding:88px 24px;text-align:center;
}
.testimonial-inner{
  max-width:540px;margin:0 auto;
  opacity:0;transform:translateY(16px);
  transition:opacity .6s ease,transform .6s ease;
}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{
  font-family:var(--font-display);
  font-size:clamp(20px,5vw,30px);
  font-weight:300;font-style:italic;
  color:#fff;line-height:1.5;margin-bottom:28px;
}
.testimonial-name{
  font-size:12px;font-weight:500;
  letter-spacing:2px;text-transform:uppercase;
  color:rgba(255,255,255,.6);
}

/* ── CONTACT — "Pop in and see us" ───────── */
.contact{
  background:var(--warm-white);
  padding:88px 24px;
}
.contact-inner{max-width:620px;margin:0 auto}
.contact-headline{
  font-family:var(--font-display);
  font-size:clamp(32px,7vw,52px);
  font-weight:300;line-height:1.1;
  letter-spacing:-.3px;color:var(--warm-dark);
  margin-bottom:10px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{font-style:italic;color:var(--primary)}
.contact-directions{
  font-size:16px;font-weight:300;
  color:var(--muted);line-height:1.7;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.contact-directions.visible{opacity:1;transform:none}
.contact-actions{
  display:flex;gap:12px;flex-wrap:wrap;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .2s ease,transform .5s .2s ease;
}
.contact-actions.visible{opacity:1;transform:none}
.btn-contact-wa{
  background:var(--primary);color:#fff;
  padding:16px 28px;border-radius:100px;
  font-size:15px;font-weight:500;
  text-decoration:none;display:flex;
  align-items:center;gap:8px;
  transition:opacity .2s;
}
.btn-contact-wa:hover{opacity:.9}
.btn-contact-call{
  border:1.5px solid var(--parchment);color:var(--warm-dark);
  padding:15px 28px;border-radius:100px;
  font-size:15px;font-weight:400;
  text-decoration:none;display:flex;
  align-items:center;gap:8px;
  transition:border-color .2s;
}
.btn-contact-call:hover{border-color:var(--primary);color:var(--primary)}
.contact-cards{display:flex;flex-direction:column;gap:12px}
.contact-card{
  background:var(--cream);border-radius:16px;
  padding:20px;display:flex;gap:16px;
  align-items:flex-start;
  opacity:0;transform:translateY(10px);
  transition:opacity .4s ease,transform .4s ease;
}
.contact-card.visible{opacity:1;transform:none}
.contact-card-icon{font-size:20px;flex-shrink:0;margin-top:2px}
.contact-card-label{
  font-size:10px;font-weight:600;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--primary);margin-bottom:4px;
}
.contact-card-value{
  font-size:15px;font-weight:400;
  color:var(--warm-dark);line-height:1.5;
}
.contact-card-link{color:var(--primary);text-decoration:none}
.hours-row{font-size:13px;color:var(--warm-dark);padding:2px 0}

/* ── FOOTER ──────────────────────────────────── */
.footer{
  background:var(--warm-dark);
  padding:48px 24px;text-align:center;
}
.footer-brand{
  font-family:var(--font-display);
  font-size:20px;font-weight:300;
  color:#fff;margin-bottom:6px;
}
.footer-tagline{
  font-size:13px;font-weight:300;
  font-style:italic;color:var(--tan);
  margin-bottom:24px;
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
.wa-float{
  position:fixed;bottom:24px;right:24px;z-index:90;
  background:var(--primary);color:#fff;
  width:56px;height:56px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-size:24px;text-decoration:none;
  box-shadow:0 4px 20px rgba(212,114,42,.4);
  transition:transform .2s;
}
.wa-float:hover{transform:scale(1.08)}

/* ── ANIMATIONS ──────────────────────────────── */
@keyframes heroReveal{from{transform:scale(1.06)}to{transform:scale(1)}}
@keyframes driftUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes scrollPulse{0%,100%{opacity:.3}50%{opacity:.7}}
</style>
</head>
<body>

<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(client.business_name)}</a>
  <div class="nav-links">
    ${!isExp ? `<a href="#about" class="nav-link">Our story</a>` : ''}
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Reviews</a>` : ''}
    <a href="#contact" class="nav-link">Find us</a>
    <a href="${esc(waLink)}" class="nav-link nav-wa">WhatsApp</a>
  </div>
</nav>

<section class="hero">
  <div class="hero-bg"></div>
  ${rating ? `
  <div class="hero-rating">
    <div class="rating-num">${rating}</div>
    <div class="rating-stars">${'★'.repeat(Math.round(rating))}</div>
    <div class="rating-count">${reviewCount} reviews</div>
  </div>` : ''}
  <div class="hero-content">
    <div class="hero-neighbourhood">
      <div class="neighbourhood-dot"></div>
      <div class="neighbourhood-text">${esc(area) || esc(domain)}</div>
    </div>
    <h1 class="hero-h1">
      ${esc(t.hero_h1_line1 || '')}
      ${t.hero_h1_line2 ? `<br><em>${esc(t.hero_h1_line2)}</em>` : ''}
    </h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-ctas">
      <a href="${esc(waLink)}" class="btn-primary-local">💬 ${esc(t.hero_cta || 'WhatsApp Us')}</a>
      <a href="#${!isExp ? 'about' : 'services'}" class="btn-ghost-local">Our story ↓</a>
    </div>
  </div>
  <div class="scroll-nudge">
    <div class="scroll-nudge-line"></div>
    <span>Scroll</span>
  </div>
</section>

<div class="since-ribbon">${yearsLine}</div>

${!isExp ? `
<section class="about" id="about">
  <div class="about-inner">
    <div class="section-tag">${esc(t.section_label_about || 'OUR STORY')}</div>
    <h2 class="about-headline">${esc(t.about_headline || '')}</h2>
    <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    <p class="about-body">${esc(t.about_p1 || '')}</p>
    ${t.about_p2 ? `<p class="about-body" style="transition-delay:.2s">${esc(t.about_p2)}</p>` : ''}
  </div>
</section>` : ''}

<section class="services" id="services">
  <div class="services-inner">
    <div class="section-tag">${esc(t.section_label_services || 'WHAT WE DO')}</div>
    <h2 class="services-headline">${esc(t.services_headline || '')}</h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-card" style="transition-delay:${i*.08}s">
      <div class="service-badge">${s.icon || '✦'}</div>
      <div>
        <div class="service-name">${esc(s.name || '')}</div>
        ${!isExp && s.desc ? `<div class="service-desc">${esc(s.desc)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>
</section>

${reviews.length && !isExp ? `
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <h2 class="reviews-title">What the <em>regulars say</em></h2>
      ${rating ? `
      <div class="reviews-aggregate">
        <div class="reviews-rating-num">${rating}</div>
        <div class="reviews-rating-stars">${'★'.repeat(Math.round(rating))}</div>
        <div class="reviews-rating-count">${reviewCount} GOOGLE REVIEWS</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-card" style="transition-delay:${i*.1}s">
      <p class="review-text">${esc(r.text || '')}</p>
      <div class="review-footer">
        <span class="review-stars">${'★'.repeat(r.rating || 5)}</span>
        <span class="review-name">${esc(r.author || '')}</span>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-tag">${esc(t.section_label_whyus || 'WHY US')}</div>
    <h2 class="services-headline">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-row" style="transition-delay:${i*.1}s">
      <div class="diff-icon">✦</div>
      <div>
        <div class="diff-title">${esc(d.title)}</div>
        <div class="diff-body">${esc(d.body || '')}</div>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${t.testimonial_quote && !isExp ? `
<section class="testimonial">
  <div class="testimonial-inner">
    <p class="testimonial-quote">${esc(t.testimonial_quote)}</p>
    <div class="testimonial-name">${esc(t.testimonial_name || '')}</div>
  </div>
</section>` : ''}

<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="section-tag">${esc(t.section_label_contact || 'FIND US')}</div>
    <h2 class="contact-headline">Pop in and <em>see us</em></h2>
    <p class="contact-directions">${esc(t.contact_subline || address || 'We\'re right here in the neighbourhood — come say hello.')}</p>
    <div class="contact-actions">
      <a href="${esc(waLink)}" class="btn-contact-wa">💬 ${esc(t.contact_cta || 'WhatsApp Us')}</a>
      <a href="${esc(callLink)}" class="btn-contact-call">📞 ${phoneDisplay || esc(client.phone || 'Call us')}</a>
    </div>
    <div class="contact-cards">
      ${client.phone ? `
      <div class="contact-card">
        <div class="contact-card-icon">📞</div>
        <div>
          <div class="contact-card-label">Give us a ring</div>
          <a href="${esc(callLink)}" class="contact-card-value contact-card-link">${phoneDisplay}</a>
        </div>
      </div>` : ''}
      ${address ? `
      <div class="contact-card" style="transition-delay:.1s">
        <div class="contact-card-icon">📍</div>
        <div>
          <div class="contact-card-label">You'll find us here</div>
          <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="contact-card-value contact-card-link">${esc(address)}</a>
        </div>
      </div>` : ''}
      ${hours.length ? `
      <div class="contact-card" style="transition-delay:.2s">
        <div class="contact-card-icon">🕐</div>
        <div>
          <div class="contact-card-label">We're open</div>
          <div>${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
        </div>
      </div>` : ''}
      ${gbpData?.payment?.acceptsCreditCards ? `
      <div class="contact-card" style="transition-delay:.3s">
        <div class="contact-card-icon">💳</div>
        <div>
          <div class="contact-card-label">Payment</div>
          <div class="contact-card-value">Card${gbpData.payment.acceptsDebitCards ? ', debit' : ''} and cash — no stress</div>
        </div>
      </div>` : ''}
    </div>
  </div>
</section>

<footer class="footer">
  <div class="footer-brand">${esc(client.business_name)}</div>
  <div class="footer-tagline">${yearsLine}</div>
  <div class="footer-links">
    <a href="${esc(waLink)}" class="footer-link">WhatsApp</a>
    ${client.instagram ? `<a href="https://instagram.com/${esc((client.instagram||'').replace('@',''))}" class="footer-link" target="_blank">Instagram</a>` : ''}
    ${client.facebook ? `<a href="https://facebook.com/${esc(client.facebook||'')}" class="footer-link" target="_blank">Facebook</a>` : ''}
    <a href="#" class="footer-link">Back to top ↑</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} ${esc(client.business_name)} · ${esc(domain)}</div>
</footer>

<a href="${esc(waLink)}" class="wa-float" aria-label="WhatsApp">💬</a>

<script>
const nav=document.getElementById('nav');
window.addEventListener('scroll',()=>{nav.classList.toggle('scrolled',window.scrollY>60)},{passive:true});

const obs=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target)}});
},{threshold:0.12,rootMargin:'0px 0px -32px 0px'});

document.querySelectorAll('.section-tag,.about-headline,.about-pull,.about-body,.services-headline,.service-card,.review-card,.diff-row,.testimonial-inner,.contact-headline,.contact-directions,.contact-actions,.contact-card').forEach(el=>obs.observe(el));

document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{
    const t=document.querySelector(a.getAttribute('href'));
    if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}
  });
});
</script>
</body>
</html>`;
}
