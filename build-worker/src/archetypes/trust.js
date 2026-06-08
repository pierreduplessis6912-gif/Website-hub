/**
 * TRUST ARCHETYPE — Where Professionalism Lives
 *
 * For: lawyer, attorney, accountant, doctor, dentist, optometrist,
 *      financial advisor, estate agent, tax consultant, architect,
 *      physiotherapist, audiologist, specialist, bond originator
 *
 * Feel: Boardrooms and coffee. Deep leather furniture. Composed, poised,
 *       ready to change the world. The people you depend on with your life.
 *       Clean whites and deep navies. Zero noise. The restraint IS the message.
 *       Credentials whisper authority. The CTA is an appointment, not a call.
 */

export function generateTrustHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone    = (client.phone || '').replace(/\D/g, '');
  const domain   = client.domain || `${client.slug}.co.za`;
  const waLink   = `https://wa.me/${phone}`;
  const callLink = `tel:${client.phone || ''}`;
  const isExp    = pkg === 'express';
  const isPrem   = pkg === 'premium';

  const primary  = brandBrief?.primary_colour || '#1a3a6b';
  const accent   = brandBrief?.accent_colour  || '#b8902a';
  const svcs     = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';
  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);

  const phoneDisplay = (client.phone || '').replace(/^\+?27/, '0').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Industry-specific CTA language
  const industry = (cards?.industry || client.industry || '').toLowerCase();
  const ctaLabel =
    /legal|law|attorney|advocate/.test(industry)           ? 'Schedule a Consultation' :
    /account|tax|financial|mortgage|bond/.test(industry)   ? 'Book a Meeting' :
    /doctor|gp|dental|dentist|optom|physio|hearing/.test(industry) ? 'Book an Appointment' :
    /property|estate/.test(industry)                        ? 'Request a Valuation' :
    'Schedule a Consultation';

  const credentialLine =
    /legal|law|attorney/.test(industry)     ? 'Admitted to the Bar · South Africa' :
    /account|tax/.test(industry)            ? 'Registered with SAICA · South Africa' :
    /financial|bond|mortgage/.test(industry)? 'FSP Licensed · South Africa' :
    /doctor|gp/.test(industry)              ? 'Registered with HPCSA · South Africa' :
    /dental/.test(industry)                 ? 'Registered Dentist · South Africa' :
    /optom/.test(industry)                  ? 'Registered Optometrist · South Africa' :
    /property|estate/.test(industry)        ? 'Registered with PPRA · South Africa' :
    'Registered Professional · South Africa';

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
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Source+Sans+3:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --navy:${primary};
  --gold:${accent};
  --white:#ffffff;
  --off-white:#f8f6f2;
  --light-grey:#f2f0ec;
  --mid-grey:#e8e5df;
  --text:#1a1814;
  --muted:#6b6560;
  --font-display:'Playfair Display',Georgia,serif;
  --font-body:'Source Sans 3',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--white);color:var(--text);overflow-x:hidden}

/* ── NAV ──────────────────────────────────── */
.nav{
  position:fixed;top:0;left:0;right:0;z-index:100;
  display:flex;align-items:center;justify-content:space-between;
  padding:20px 40px;
  background:rgba(255,255,255,.97);
  border-bottom:1px solid transparent;
  transition:border-color .4s,box-shadow .4s;
}
.nav.scrolled{
  border-color:var(--mid-grey);
  box-shadow:0 1px 20px rgba(0,0,0,.06);
}
.nav-brand{
  font-family:var(--font-display);
  font-size:18px;font-weight:500;
  color:var(--navy);text-decoration:none;
  letter-spacing:.3px;
}
.nav-links{display:flex;align-items:center;gap:14px;flex-shrink:0}
.nav-link{
  color:var(--muted);font-size:13px;font-weight:400;
  letter-spacing:.3px;text-decoration:none;
  transition:color .2s;
}
.nav-link:hover{color:var(--navy)}
.nav-cta{
  display:block!important;white-space:nowrap;
  background:var(--navy);color:var(--white)!important;
  padding:10px 22px;font-size:13px;font-weight:500;
  letter-spacing:.3px;border-radius:2px;
  transition:background .2s;
}
.nav-cta:hover{background:color-mix(in srgb,var(--navy) 85%,#000)}

/* ── HERO ──────────────────────────────────── */
.hero{
  padding-top:80px;
  min-height:100svh;
  display:grid;
  grid-template-columns:1fr 1fr;
  position:relative;overflow:hidden;
}
/* Left — credentials and headline */
.hero-left{
  display:flex;flex-direction:column;
  justify-content:center;
  padding:80px 48px 80px 40px;
  background:var(--white);
  position:relative;z-index:2;
}
.hero-credential{
  display:inline-flex;align-items:center;gap:10px;
  margin-bottom:32px;
  animation:fadeUp .6s .2s ease both;
}
.credential-line{
  width:32px;height:1px;background:var(--gold);
}
.credential-text{
  font-size:11px;font-weight:500;letter-spacing:2px;
  text-transform:uppercase;color:var(--gold);
}
.hero-h1{
  font-family:var(--font-display);
  font-size:clamp(36px,4vw,56px);
  font-weight:400;line-height:1.15;
  letter-spacing:-.3px;color:var(--navy);
  margin-bottom:20px;
  animation:fadeUp .6s .3s ease both;
}
.hero-h1 em{font-style:italic;color:var(--gold)}
.hero-subline{
  font-size:17px;font-weight:300;
  color:var(--muted);line-height:1.7;
  max-width:380px;margin-bottom:40px;
  animation:fadeUp .6s .4s ease both;
}
.hero-cta-wrap{
  display:flex;flex-direction:column;gap:12px;
  animation:fadeUp .6s .5s ease both;
}
.btn-primary-trust{
  background:var(--navy);color:var(--white);
  padding:16px 28px;border-radius:2px;
  font-size:14px;font-weight:500;letter-spacing:.3px;
  text-decoration:none;display:inline-flex;
  align-items:center;gap:10px;
  width:fit-content;
  transition:background .2s;
}
.btn-primary-trust:hover{background:color-mix(in srgb,var(--navy) 85%,#000)}
.btn-secondary-trust{
  color:var(--navy);font-size:13px;font-weight:400;
  text-decoration:none;display:inline-flex;
  align-items:center;gap:8px;width:fit-content;
  padding-bottom:2px;
  border-bottom:1px solid var(--mid-grey);
  transition:border-color .2s;
}
.btn-secondary-trust:hover{border-color:var(--navy)}
.hero-trust-note{
  margin-top:32px;padding-top:32px;
  border-top:1px solid var(--mid-grey);
  display:flex;align-items:center;gap:12px;
  animation:fadeUp .6s .6s ease both;
}
.trust-note-text{
  font-size:12px;font-weight:400;
  color:var(--muted);line-height:1.5;
}

/* Right — full photo */
.hero-right{
  position:relative;overflow:hidden;
}
.hero-img{
  position:absolute;inset:0;
  background-image:url('${esc(heroUrl)}');
  background-size:cover;background-position:center top;
  animation:heroReveal .8s cubic-bezier(.16,1,.3,1) both;
}
.hero-img::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(
    to right,
    rgba(255,255,255,.15) 0%,
    transparent 30%
  );
}
/* Rating badge — lower right of photo */
.hero-rating{
  position:absolute;top:76px;right:20px;
  background:rgba(255,255,255,.95);
  border:1px solid var(--mid-grey);
  border-radius:2px;padding:16px 20px;
  text-align:center;z-index:2;
  box-shadow:0 4px 20px rgba(0,0,0,.08);
  animation:fadeUp .6s 1s ease both;
}
.rating-num{
  font-family:var(--font-display);
  font-size:32px;font-weight:400;
  color:var(--navy);line-height:1;
}
.rating-stars{color:var(--gold);font-size:12px;margin:4px 0;letter-spacing:2px}
.rating-count{font-size:11px;color:var(--muted);letter-spacing:.5px}

/* Mobile hero */
@media(max-width:680px){
  .hero{grid-template-columns:1fr;grid-template-rows:auto 320px}
  .hero-left{padding:60px 24px 40px}
  .hero-h1{font-size:clamp(32px,10vw,48px)}
  .hero-right{grid-row:1;margin-top:80px;height:320px}
  .hero-img{position:absolute}
  .hero-rating{top:76px;right:20px}
}

/* ── CREDENTIALS BAR ──────────────────────── */
.cred-bar{
  background:var(--navy);
  padding:20px 40px;
  display:flex;align-items:center;
  justify-content:center;gap:48px;
  flex-wrap:wrap;
}
.cred-item{
  display:flex;align-items:center;gap:10px;
  font-size:12px;font-weight:500;
  letter-spacing:1px;text-transform:uppercase;
  color:rgba(255,255,255,.8);
}
.cred-divider{
  width:1px;height:20px;
  background:rgba(255,255,255,.2);
}

/* ── SERVICES ──────────────────────────────── */
.services{
  background:var(--white);
  padding:100px 40px;
}
.services-inner{max-width:760px;margin:0 auto}
.section-label{
  font-size:10px;font-weight:600;
  letter-spacing:4px;text-transform:uppercase;
  color:var(--gold);margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s ease,transform .5s ease;
}
.section-label.visible{opacity:1;transform:none}
.section-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,4vw,44px);
  font-weight:400;line-height:1.2;
  letter-spacing:-.2px;color:var(--navy);
  margin-bottom:56px;max-width:560px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s .05s ease,transform .5s .05s ease;
}
.section-headline.visible{opacity:1;transform:none}
.section-headline em{font-style:italic;color:var(--gold)}
.service-item{
  display:grid;grid-template-columns:80px 1fr;
  gap:24px;align-items:start;
  padding:32px 0;
  border-bottom:1px solid var(--mid-grey);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.service-item:last-child{border-bottom:none}
.service-item.visible{opacity:1;transform:none}
.service-num{
  font-family:var(--font-display);
  font-size:36px;font-weight:400;
  color:var(--mid-grey);line-height:1;
  font-style:italic;
}
.service-name{
  font-family:var(--font-display);
  font-size:20px;font-weight:500;
  color:var(--navy);margin-bottom:6px;
}
.service-desc{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.6;
}

/* ── ABOUT ──────────────────────────────────── */
.about{
  background:var(--off-white);
  padding:100px 40px;
}
.about-inner{
  max-width:760px;margin:0 auto;
  display:grid;grid-template-columns:1fr 1fr;gap:64px;
  align-items:start;
}
@media(max-width:680px){
  .about-inner{grid-template-columns:1fr;gap:32px}
}
.about-left{}
.about-right{}
.about-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,4vw,40px);
  font-weight:400;line-height:1.2;
  letter-spacing:-.2px;color:var(--navy);
  margin-bottom:24px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{font-style:italic}
.about-pull{
  font-family:var(--font-display);
  font-size:18px;font-style:italic;font-weight:400;
  color:var(--navy);line-height:1.5;
  padding-left:20px;border-left:2px solid var(--gold);
  margin-bottom:28px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.about-pull.visible{opacity:1;transform:none}
.about-body{
  font-size:15px;font-weight:300;
  color:var(--muted);line-height:1.8;
  margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .15s ease,transform .5s .15s ease;
}
.about-body.visible{opacity:1;transform:none}

/* ── WHY US ──────────────────────────────────── */
.whyus{
  background:var(--white);
  padding:100px 40px;
}
.whyus-inner{max-width:760px;margin:0 auto}
.diff-item{
  padding:36px 0;
  border-bottom:1px solid var(--mid-grey);
  display:grid;grid-template-columns:48px 1fr;gap:24px;align-items:start;
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.diff-item:last-child{border-bottom:none}
.diff-item.visible{opacity:1;transform:none}
.diff-num{
  font-family:var(--font-display);
  font-size:13px;font-weight:400;font-style:italic;
  color:var(--gold);padding-top:4px;
}
.diff-title{
  font-family:var(--font-display);
  font-size:22px;font-weight:500;
  color:var(--navy);margin-bottom:8px;
}
.diff-body{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.7;
}

/* ── REVIEWS ──────────────────────────────────── */
.reviews{
  background:var(--navy);
  padding:100px 40px;
}
.reviews-inner{max-width:760px;margin:0 auto}
.reviews-header{
  display:flex;align-items:flex-end;
  justify-content:space-between;
  margin-bottom:56px;flex-wrap:wrap;gap:24px;
}
.reviews-title{
  font-family:var(--font-display);
  font-size:clamp(28px,4vw,40px);
  font-weight:400;color:var(--white);line-height:1.2;
}
.reviews-title em{font-style:italic;color:var(--gold)}
.reviews-rating-num{
  font-family:var(--font-display);
  font-size:44px;font-weight:400;
  color:var(--gold);line-height:1;
}
.reviews-rating-stars{color:var(--gold);font-size:13px;margin:4px 0;letter-spacing:2px}
.reviews-rating-count{font-size:11px;color:rgba(255,255,255,.4);letter-spacing:.5px}
.review-item{
  padding:40px 0;
  border-bottom:1px solid rgba(255,255,255,.1);
  opacity:0;transform:translateY(12px);
  transition:opacity .5s ease,transform .5s ease;
}
.review-item:last-child{border-bottom:none}
.review-item.visible{opacity:1;transform:none}
.review-quote{
  font-family:var(--font-display);
  font-size:clamp(16px,2.5vw,20px);
  font-weight:400;font-style:italic;
  color:rgba(255,255,255,.9);line-height:1.6;
  margin-bottom:20px;
}
.review-quote::before{
  content:'\u201C';color:var(--gold);
  font-size:1.4em;vertical-align:-.1em;margin-right:3px;
}
.review-quote::after{
  content:'\u201D';color:var(--gold);
  font-size:1.4em;vertical-align:-.1em;margin-left:3px;
}
.review-attr{
  display:flex;align-items:center;gap:16px;
  font-size:12px;letter-spacing:1px;text-transform:uppercase;
}
.review-stars{color:var(--gold);letter-spacing:2px}
.review-name{color:rgba(255,255,255,.5);font-weight:500}

/* ── TESTIMONIAL ──────────────────────────────── */
.testimonial{
  background:var(--light-grey);
  padding:100px 40px;
  text-align:center;
}
.testimonial-inner{
  max-width:640px;margin:0 auto;
  opacity:0;transform:translateY(16px);
  transition:opacity .6s ease,transform .6s ease;
}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{
  font-family:var(--font-display);
  font-size:clamp(20px,3vw,28px);
  font-weight:400;font-style:italic;
  color:var(--navy);line-height:1.5;
  margin-bottom:28px;
}
.testimonial-rule{
  width:40px;height:1px;
  background:var(--gold);
  margin:0 auto 20px;
}
.testimonial-name{
  font-size:12px;font-weight:600;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--gold);
}
.testimonial-context{
  font-size:12px;font-weight:300;
  color:var(--muted);margin-top:4px;
}

/* ── CONTACT ──────────────────────────────────── */
.contact{
  background:var(--white);
  padding:100px 40px;
}
.contact-inner{
  max-width:760px;margin:0 auto;
  display:grid;grid-template-columns:1fr 1fr;gap:64px;
  align-items:start;
}
@media(max-width:680px){
  .contact-inner{grid-template-columns:1fr;gap:40px}
}
.contact-left{}
.contact-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,4vw,44px);
  font-weight:400;line-height:1.15;
  letter-spacing:-.2px;color:var(--navy);
  margin-bottom:12px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{font-style:italic;color:var(--gold)}
.contact-subline{
  font-size:15px;font-weight:300;
  color:var(--muted);line-height:1.6;
  margin-bottom:36px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.contact-subline.visible{opacity:1;transform:none}
.contact-ctas{
  display:flex;flex-direction:column;gap:12px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .2s ease,transform .5s .2s ease;
}
.contact-ctas.visible{opacity:1;transform:none}
.btn-appt{
  background:var(--navy);color:var(--white);
  padding:16px 28px;border-radius:2px;
  font-size:14px;font-weight:500;letter-spacing:.3px;
  text-decoration:none;display:flex;
  align-items:center;gap:10px;
  transition:background .2s;
}
.btn-appt:hover{background:color-mix(in srgb,var(--navy) 85%,#000)}
.btn-appt-wa{
  border:1px solid var(--mid-grey);color:var(--navy);
  padding:15px 28px;border-radius:2px;
  font-size:13px;font-weight:400;letter-spacing:.3px;
  text-decoration:none;display:flex;
  align-items:center;gap:10px;
  transition:border-color .2s;
}
.btn-appt-wa:hover{border-color:var(--navy)}
.contact-right{
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .3s ease,transform .5s .3s ease;
}
.contact-right.visible{opacity:1;transform:none}
.contact-detail{
  padding:20px 0;
  border-bottom:1px solid var(--mid-grey);
}
.contact-detail:last-child{border-bottom:none}
.contact-detail-label{
  font-size:10px;font-weight:600;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--gold);margin-bottom:6px;
}
.contact-detail-value{
  font-size:15px;font-weight:300;
  color:var(--text);line-height:1.5;
}
.contact-detail-link{color:var(--navy);text-decoration:none}
.contact-detail-link:hover{color:var(--gold)}
.hours-row{font-size:13px;color:var(--text);padding:2px 0}

/* ── FOOTER ──────────────────────────────────── */
.footer{
  background:var(--navy);
  padding:40px 40px;
  display:flex;align-items:center;
  justify-content:space-between;flex-wrap:wrap;gap:20px;
}
.footer-brand{
  font-family:var(--font-display);
  font-size:16px;font-weight:400;
  color:rgba(255,255,255,.9);
  text-decoration:none;
}
.footer-links{display:flex;gap:24px;flex-wrap:wrap}
.footer-link{
  font-size:12px;color:rgba(255,255,255,.4);
  text-decoration:none;letter-spacing:.3px;
  transition:color .2s;
}
.footer-link:hover{color:var(--gold)}
.footer-copy{
  font-size:11px;color:rgba(255,255,255,.2);
  width:100%;
}

/* ── FLOATING CTA ──────────────────────────── */
/* Dual FAB — WhatsApp + Call */
.fab-stack{position:fixed;bottom:24px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:999}
.fab-btn{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.25);text-decoration:none;font-size:22px;transition:transform .2s,box-shadow .2s}
.fab-btn:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,.35)}
.fab-wa{background:#25D366}
.fab-call{background:#007AFF}

/* ── ANIMATIONS ──────────────────────────────── */
@keyframes heroReveal{from{transform:scale(1.04)}to{transform:scale(1)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>

<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="nav-links">
    ${!isExp ? `<a href="#about" class="nav-link">About</a>` : ''}
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Testimonials</a>` : ''}
    <a href="#contact" class="nav-link">Contact</a>
    <a href="#contact" class="nav-link nav-cta">${esc(ctaLabel)}</a>
  </div>
</nav>

<!-- Hero — split layout -->
<section class="hero">
  <div class="hero-left">
    <div class="hero-credential">
      <div class="credential-line"></div>
      <div class="credential-text">${esc(credentialLine)}</div>
    </div>
    <h1 class="hero-h1">
      ${esc(t.hero_h1_line1 || '')}
      ${t.hero_h1_line2 ? `<br><em>${esc(t.hero_h1_line2)}</em>` : ''}
    </h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-cta-wrap">
      <a href="#contact" class="btn-primary-trust">${esc(ctaLabel)} →</a>
      <a href="${esc(waLink)}" class="btn-secondary-trust">💬 WhatsApp us</a>
    </div>
    <div class="hero-trust-note">
      <div class="credential-line"></div>
      <div class="trust-note-text">${esc(t.hero_trust_line || 'Confidential · Professional · Dependable')}</div>
    </div>
  </div>
  <div class="hero-right">
    <div class="hero-img"></div>
    ${rating ? `
    <div class="hero-rating">
      <div class="rating-num">${rating}</div>
      <div class="rating-stars">${'★'.repeat(Math.round(rating))}${'☆'.repeat(5-Math.round(rating))}</div>
      <div class="rating-count">${reviewCount} reviews</div>
    </div>` : ''}
  </div>
</section>

<!-- Credentials bar -->
<div class="cred-bar">
  <div class="cred-item">${esc(credentialLine.split('·')[0].trim())}</div>
  <div class="cred-divider"></div>
  <div class="cred-item">${esc(client.area || 'South Africa')}</div>
  <div class="cred-divider"></div>
  <div class="cred-item">Confidential Service</div>
  ${gbpData?.payment?.acceptsCreditCards ? `<div class="cred-divider"></div><div class="cred-item">Card Accepted</div>` : ''}
</div>

<!-- Services -->
<section class="services" id="services">
  <div class="services-inner">
    <div class="section-label">${esc(t.section_label_services || 'OUR SERVICES')}</div>
    <h2 class="section-headline">${esc(t.services_headline || '')} <em>for you</em></h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-item" style="transition-delay:${i*.08}s">
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
    <div class="about-left">
      <div class="section-label">${esc(t.section_label_about || 'ABOUT US')}</div>
      <h2 class="about-headline">${esc(t.about_headline || '')}</h2>
      <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    </div>
    <div class="about-right">
      <p class="about-body">${esc(t.about_p1 || '')}</p>
      ${t.about_p2 ? `<p class="about-body" style="transition-delay:.2s">${esc(t.about_p2)}</p>` : ''}
    </div>
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<!-- Why Us -->
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-label">${esc(t.section_label_whyus || 'WHY CHOOSE US')}</div>
    <h2 class="section-headline" style="margin-bottom:8px">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-item" style="transition-delay:${i*.1}s">
      <div class="diff-num">0${i+1}.</div>
      <div>
        <div class="diff-title">${esc(d.title)}</div>
        <div class="diff-body">${esc(d.body || '')}</div>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${reviews.length && !isExp ? `
<!-- Reviews -->
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <h2 class="reviews-title">Client <em>testimonials</em></h2>
      ${rating ? `
      <div style="text-align:right">
        <div class="reviews-rating-num">${rating}</div>
        <div class="reviews-rating-stars">${'★'.repeat(Math.round(rating))}</div>
        <div class="reviews-rating-count">${reviewCount} GOOGLE REVIEWS</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-item" style="transition-delay:${i*.12}s">
      <p class="review-quote">${esc(r.text || '')}</p>
      <div class="review-attr">
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
    <div class="testimonial-rule"></div>
    <div class="testimonial-name">${esc(t.testimonial_name || '')}</div>
    <div class="testimonial-context">${esc(t.testimonial_context || '')}</div>
  </div>
</section>` : ''}

<!-- Contact -->
<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="contact-left">
      <div class="section-label">${esc(t.section_label_contact || 'GET IN TOUCH')}</div>
      <h2 class="contact-headline">${esc(t.contact_headline || '')} <em>${esc(t.contact_subline || '')}</em></h2>
      <div class="contact-ctas">
        <a href="${esc(waLink)}" class="btn-appt">💬 ${esc(ctaLabel)}</a>
        <a href="tel:${esc(client.phone || '')}" class="btn-appt-wa">📞 ${esc(client.phone || 'Call us')}</a>
      </div>
    </div>
    <div class="contact-right">
      ${client.phone ? `
      <div class="contact-detail">
        <div class="contact-detail-label">Telephone</div>
        <a href="tel:${esc(client.phone)}" class="contact-detail-value contact-detail-link">${esc(client.phone)}</a>
      </div>` : ''}
      ${address ? `
      <div class="contact-detail">
        <div class="contact-detail-label">Address</div>
        <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="contact-detail-value contact-detail-link">${esc(address)}</a>
      </div>` : ''}
      ${hours.length ? `
      <div class="contact-detail">
        <div class="contact-detail-label">Office Hours</div>
        <div>${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
      </div>` : ''}
      <div class="contact-detail">
        <div class="contact-detail-label">Service Area</div>
        <div class="contact-detail-value">${esc(client.area || 'South Africa')}</div>
      </div>
    </div>
  </div>
</section>

<!-- Footer -->
<footer class="footer">
  <a href="#" class="footer-brand">${esc(t.short_name || client.business_name)}</a>
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

document.querySelectorAll('.section-label,.section-headline,.service-item,.about-headline,.about-pull,.about-body,.diff-item,.review-item,.testimonial-inner,.contact-headline,.contact-subline,.contact-ctas,.contact-right').forEach(el=>obs.observe(el));

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
