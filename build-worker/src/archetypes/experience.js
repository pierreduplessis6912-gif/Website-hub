/**
 * EXPERIENCE ARCHETYPE — The World You Step Into
 *
 * For: restaurant, salon, spa, bakery, florist, coffee shop, lodge,
 *      guest house, wedding, event venue, lashes, massage, beauty, B&B
 *
 * Feel: A photograph slowly coming into focus. The smell of something
 *       warm. Words that arrive unhurried, like a letter written by hand.
 *       Nothing fights for attention. Sections breathe. Images dissolve
 *       into each other like memory bleeds into memory.
 *
 * References: Lanserhof (restraint, weight, silence)
 *             Float Luxury Spa (warmth, approachability, directness)
 */

export function generateExperienceHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone   = (client.phone || '').replace(/\D/g, '');
  const domain  = client.domain || (pkg === 'hub_pro' ? `${client.slug}.co.za` : `${client.slug}.websitehub.co.za`);
  const waLink  = `https://wa.me/${phone}`;
  const isExp   = pkg === 'express';

  const primary = brandBrief?.primary_colour || '#b8956a';
  const accent  = brandBrief?.accent_colour  || '#d4b896';
  const svcs    = t.services || [];

  const reviews     = (gbpData?.reviews || []).slice(0, 3);
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || client.area || '';

  const phoneDisplay = (client.phone || '').replace(/^\+?27/, '0').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Gallery — use GBP photos if available, else fall back
  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);
  const hasGallery = galleryPhotos.length >= 2;

  // Industry — for ambient particle personality
  const industry = (cards?.industry || client.industry || '').toLowerCase();
  const isFood   = /restaurant|bakery|cafe|coffee|catering|food|bistro/.test(industry);
  const isSpa    = /spa|massage|yoga|pilates|wellness|beauty|salon|nail|lash|wax|barber|hair/.test(industry);
  const isLodge  = /lodge|guest.house|airbnb|b.b|bnb|camp|retreat|villa|hotel/.test(industry);
  const isFloral = /florist|flower|nursery|garden/.test(industry);
  const isEvent  = /wedding|event|venue|party/.test(industry);

  // Palette personality — warm vs cool
  const isWarm = isFood || isSpa || isFloral || isEvent;
  const bgPage  = isWarm ? '#faf8f5' : '#f8f8f6';
  const bgDark  = '#0f0d0b';
  const bgMid   = isWarm ? '#f2ede6' : '#efefed';

  // Tagline — short emotional statement above fold
  const missionStatement = t.hero_trust_line || t.about_pull_quote || '';

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
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --dark:${bgDark};
  --page:${bgPage};
  --mid:${bgMid};
  --muted:#8a7d6e;
  --serif:'Cormorant Garamond',Georgia,serif;
  --sans:'Jost',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
body{font-family:var(--sans);background:var(--page);color:var(--dark);overflow-x:hidden}

/* ── NAV ── */
.nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:20px 24px;transition:all .5s ease}
.nav.scrolled{background:rgba(15,13,11,.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);padding:14px 24px}
.nav-brand{font-family:var(--serif);font-size:15px;font-weight:400;color:#fff;letter-spacing:.3px;text-decoration:none;max-width:55vw;line-height:1.2;transition:opacity .3s}
.nav-brand:hover{opacity:.75}
.nav-links{display:flex;align-items:center;gap:20px}
.nav-link{color:rgba(255,255,255,.65);font-size:12px;font-weight:400;letter-spacing:1px;text-decoration:none;transition:color .2s;display:none;text-transform:uppercase}
.nav-link:hover{color:#fff}
@media(min-width:640px){.nav-link{display:block}}
.nav-cta{background:var(--primary);color:#fff!important;padding:9px 20px;border-radius:100px;font-weight:500;display:block!important;font-size:12px;letter-spacing:.5px;text-transform:uppercase;transition:opacity .2s}
.nav-cta:hover{opacity:.85}

/* ── HERO ── */
.hero{position:relative;height:100svh;min-height:620px;display:flex;flex-direction:column;justify-content:flex-end;padding:0 28px 72px;overflow:hidden}
.hero-bg{position:absolute;inset:0;will-change:transform}
.hero-img{position:absolute;inset:0;background-image:url('${esc(heroUrl)}');background-size:cover;background-position:center;transform:scale(1.06);animation:heroReveal 2.4s cubic-bezier(.16,1,.3,1) forwards}
.hero-img::after{content:'';position:absolute;inset:0;background:linear-gradient(to bottom,rgba(15,13,11,.05) 0%,rgba(15,13,11,.15) 35%,rgba(15,13,11,.72) 80%,rgba(15,13,11,.85) 100%)}

/* Parallax handled by JS */
.hero-content{position:relative;z-index:2;max-width:600px}
.hero-label{font-family:var(--sans);font-size:10px;font-weight:500;letter-spacing:4px;text-transform:uppercase;color:var(--accent);margin-bottom:20px;opacity:0;animation:wordFade .9s .3s ease forwards}
.hero-h1{font-family:var(--serif);font-size:clamp(48px,12vw,84px);font-weight:300;line-height:1.02;letter-spacing:-1.5px;color:#fff;margin-bottom:20px}
.hero-h1 .word{display:inline-block;opacity:0;transform:translateY(22px);animation:wordRise .8s ease forwards}
.hero-h1 em{font-style:italic;color:var(--accent)}
.hero-subline{font-size:15px;font-weight:300;color:rgba(255,255,255,.72);line-height:1.7;max-width:380px;margin-bottom:40px;opacity:0;animation:wordFade .9s .95s ease forwards}
.hero-ctas{display:flex;gap:14px;flex-wrap:wrap;opacity:0;animation:wordFade .9s 1.1s ease forwards}
.btn-primary{background:var(--primary);color:#fff;padding:15px 30px;border-radius:100px;font-size:13px;font-weight:500;letter-spacing:.5px;text-decoration:none;transition:transform .25s,opacity .25s;display:inline-flex;align-items:center;gap:8px;text-transform:uppercase}
.btn-primary:hover{transform:translateY(-2px);opacity:.88}
.btn-ghost{border:1px solid rgba(255,255,255,.3);color:#fff;padding:15px 30px;border-radius:100px;font-size:13px;font-weight:300;text-decoration:none;transition:all .25s;letter-spacing:.3px}
.btn-ghost:hover{border-color:rgba(255,255,255,.65);background:rgba(255,255,255,.07)}

/* Rating pill — top right */
${rating ? `.hero-rating{position:absolute;top:80px;right:20px;background:rgba(255,255,255,.1);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.15);border-radius:20px;padding:14px 16px;text-align:center;z-index:2;opacity:0;animation:wordFade 1s 1.4s ease forwards;min-width:76px}
.rating-num{font-family:var(--serif);font-size:30px;font-weight:300;color:#fff;line-height:1}
.rating-stars{color:var(--accent);font-size:11px;margin:5px 0 3px;letter-spacing:1px}
.rating-count{font-size:10px;color:rgba(255,255,255,.5);letter-spacing:.5px}` : ''}

/* Scroll whisper */
.scroll-whisper{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;z-index:2;opacity:0;animation:wordFade 1s 1.8s ease forwards}
.scroll-line{width:1px;height:48px;background:linear-gradient(to bottom,rgba(255,255,255,.5),transparent);animation:breathe 2.5s ease-in-out infinite}
.scroll-text{font-size:9px;letter-spacing:3px;color:rgba(255,255,255,.35);text-transform:uppercase}

/* ── MISSION RIBBON ── */
.mission{background:var(--mid);padding:64px 28px;overflow:hidden}
.mission-inner{max-width:640px;margin:0 auto;text-align:center}
.mission-text{font-family:var(--serif);font-size:clamp(20px,4.5vw,30px);font-weight:300;font-style:italic;color:var(--dark);line-height:1.5;opacity:0;transform:translateY(24px);transition:opacity 1.2s cubic-bezier(.25,.1,.25,1),transform 1.2s cubic-bezier(.25,.1,.25,1)}
.mission-text.vis{opacity:1;transform:none}
.mission-rule{width:40px;height:1px;background:var(--primary);margin:24px auto 0;opacity:0;transition:opacity 1s .3s ease,width 1s .3s ease}
.mission-rule.vis{opacity:1;width:60px}

/* ── ABOUT ── */
.about{position:relative;background:var(--dark);padding:120px 28px;overflow:hidden}
.about-blur{position:absolute;inset:0;background:radial-gradient(ellipse 60% 50% at 80% 50%,rgba(${primary.replace('#','').match(/.{2}/g).map(h=>parseInt(h,16)).join(',')},0.12),transparent);pointer-events:none}
.about-inner{position:relative;z-index:2;max-width:540px}
.eyebrow{font-size:10px;font-weight:500;letter-spacing:4px;text-transform:uppercase;color:var(--primary);margin-bottom:24px;opacity:0;transform:translateY(10px);transition:opacity .7s ease,transform .7s ease}
.eyebrow.vis{opacity:1;transform:none}
.about-h2{font-family:var(--serif);font-size:clamp(38px,8vw,60px);font-weight:300;line-height:1.05;letter-spacing:-1px;color:#fff;margin-bottom:28px}
.about-h2 .line{display:block;opacity:0;transform:translateY(18px);transition:opacity .9s ease,transform .9s ease}
.about-h2 .line.vis{opacity:1;transform:none}
.about-h2 em{font-style:italic;color:var(--accent)}
.about-pull{font-family:var(--serif);font-size:clamp(17px,3.5vw,22px);font-style:italic;font-weight:300;color:var(--accent);line-height:1.6;margin-bottom:28px;padding-left:20px;border-left:1.5px solid rgba(${primary.replace('#','').match(/.{2}/g).map(h=>parseInt(h,16)).join(',')},0.5);opacity:0;transform:translateY(14px);transition:opacity .9s .15s ease,transform .9s .15s ease}
.about-pull.vis{opacity:1;transform:none}
.about-body{font-size:15px;font-weight:300;color:rgba(255,255,255,.62);line-height:1.85;margin-bottom:14px;opacity:0;transform:translateY(10px);transition:opacity .9s .25s ease,transform .9s .25s ease}
.about-body.vis{opacity:1;transform:none}

/* ── SERVICES ── */
.services{background:var(--page);padding:120px 28px}
.services-inner{max-width:640px;margin:0 auto}
.section-h2{font-family:var(--serif);font-size:clamp(30px,6.5vw,50px);font-weight:300;line-height:1.1;letter-spacing:-.5px;color:var(--dark);margin-bottom:56px;opacity:0;transform:translateY(18px);transition:opacity .9s ease,transform .9s ease}
.section-h2.vis{opacity:1;transform:none}
.section-h2 em{font-style:italic;color:var(--primary)}
.service-row{display:flex;align-items:flex-start;gap:24px;padding:32px 0;border-bottom:1px solid rgba(15,13,11,.08);opacity:0;transition:opacity .7s ease,transform .7s ease}
.service-row:last-child{border-bottom:none}
.service-row:nth-child(odd){transform:translateX(-20px)}
.service-row:nth-child(even){transform:translateX(20px)}
.service-row.vis{opacity:1;transform:none}
.svc-icon{font-size:22px;flex-shrink:0;width:52px;height:52px;background:var(--mid);border-radius:14px;display:flex;align-items:center;justify-content:center;transition:background .3s}
.service-row:hover .svc-icon{background:rgba(${primary.replace('#','').match(/.{2}/g).map(h=>parseInt(h,16)).join(',')},0.15)}
.svc-name{font-family:var(--serif);font-size:21px;font-weight:400;color:var(--dark);margin-bottom:5px}
.svc-desc{font-size:14px;font-weight:300;color:var(--muted);line-height:1.65}

/* ── GALLERY — crossfade carousel ── */
.gallery{position:relative;background:var(--dark);overflow:hidden}
.gallery-stage{position:relative;width:100%;padding-bottom:66.67%;overflow:hidden}
.gallery-slide{position:absolute;inset:0;opacity:0;transition:opacity 1.8s cubic-bezier(.25,.1,.25,1)}
.gallery-slide.active{opacity:1}
.gallery-slide img{width:100%;height:100%;object-fit:cover;display:block}
.gallery-caption{position:absolute;bottom:0;left:0;right:0;padding:32px 28px;background:linear-gradient(to top,rgba(15,13,11,.7),transparent);z-index:2;opacity:0;animation:wordFade 1s 1s ease forwards}
.gallery-caption-text{font-family:var(--serif);font-size:13px;font-weight:300;font-style:italic;color:rgba(255,255,255,.6);letter-spacing:.5px}
.gallery-progress{position:absolute;bottom:0;left:0;height:2px;background:var(--accent);width:0%;transition:none;z-index:3}
.gallery-nav{position:absolute;bottom:20px;right:20px;display:flex;gap:8px;z-index:4}
.gallery-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.3);cursor:pointer;transition:all .4s ease}
.gallery-dot.active{background:var(--accent);transform:scale(1.3)}

/* ── REVIEWS ── */
.reviews{background:var(--mid);padding:120px 28px}
.reviews-inner{max-width:640px;margin:0 auto}
.reviews-header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:64px;flex-wrap:wrap;gap:20px}
.reviews-title{font-family:var(--serif);font-size:clamp(28px,5.5vw,44px);font-weight:300;color:var(--dark);line-height:1.1}
.reviews-title em{font-style:italic;color:var(--primary)}
.reviews-score{text-align:right}
.score-num{font-family:var(--serif);font-size:52px;font-weight:300;color:var(--primary);line-height:1}
.score-stars{color:var(--primary);font-size:13px;margin:4px 0;letter-spacing:2px}
.score-count{font-size:11px;color:var(--muted);letter-spacing:.5px}
.review-block{padding:48px 0;border-bottom:1px solid rgba(15,13,11,.1);opacity:0;transform:translateY(24px);transition:opacity 1s ease,transform 1s ease}
.review-block:last-child{border-bottom:none;padding-bottom:0}
.review-block.vis{opacity:1;transform:none}
.review-q{font-family:var(--serif);font-size:clamp(18px,4vw,24px);font-weight:300;font-style:italic;color:var(--dark);line-height:1.55;margin-bottom:20px;position:relative;padding-left:24px}
.review-q::before{content:'"';position:absolute;left:0;top:-4px;font-size:2em;color:var(--primary);opacity:.5;line-height:1;font-style:normal}
.review-meta{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);padding-left:24px;display:flex;align-items:center;gap:12px}
.review-stars{color:var(--primary);letter-spacing:2px}

/* ── WHY US ── */
.whyus{background:var(--dark);padding:120px 28px}
.whyus-inner{max-width:640px;margin:0 auto}
.why-item{padding:48px 0;border-bottom:1px solid rgba(255,255,255,.07);opacity:0;transform:translateY(20px);transition:opacity .9s ease,transform .9s ease}
.why-item:last-child{border-bottom:none;padding-bottom:0}
.why-item.vis{opacity:1;transform:none}
.why-num{font-family:var(--serif);font-size:11px;letter-spacing:3px;color:var(--primary);margin-bottom:12px;font-weight:400}
.why-title{font-family:var(--serif);font-size:clamp(22px,5vw,32px);font-weight:300;color:#fff;margin-bottom:12px;line-height:1.2}
.why-body{font-size:14px;font-weight:300;color:rgba(255,255,255,.55);line-height:1.8}

/* ── FULL QUOTE ── */
.full-quote{background:var(--page);padding:120px 28px;text-align:center;position:relative;overflow:hidden}
.full-quote::before{content:'"';position:absolute;top:-40px;left:50%;transform:translateX(-50%);font-family:var(--serif);font-size:320px;font-weight:300;color:rgba(15,13,11,.04);line-height:1;pointer-events:none}
.quote-inner{position:relative;z-index:2;max-width:560px;margin:0 auto;opacity:0;transform:translateY(28px);transition:opacity 1.2s ease,transform 1.2s ease}
.quote-inner.vis{opacity:1;transform:none}
.quote-text{font-family:var(--serif);font-size:clamp(22px,5vw,34px);font-weight:300;font-style:italic;color:var(--dark);line-height:1.5;margin-bottom:32px}
.quote-name{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--primary);font-weight:500}
.quote-ctx{font-size:11px;color:var(--muted);margin-top:4px;letter-spacing:.5px}

/* ── CONTACT ── */
.contact{background:var(--mid);padding:120px 28px}
.contact-inner{max-width:640px;margin:0 auto}
.contact-h2{font-family:var(--serif);font-size:clamp(36px,8vw,62px);font-weight:300;line-height:1.05;letter-spacing:-1px;color:var(--dark);margin-bottom:12px;opacity:0;transform:translateY(18px);transition:opacity .9s ease,transform .9s ease}
.contact-h2.vis{opacity:1;transform:none}
.contact-h2 em{font-style:italic;color:var(--primary)}
.contact-sub{font-size:15px;font-weight:300;color:var(--muted);line-height:1.7;margin-bottom:52px;opacity:0;transform:translateY(10px);transition:opacity .9s .12s ease,transform .9s .12s ease}
.contact-sub.vis{opacity:1;transform:none}
.contact-wa{display:flex;align-items:center;justify-content:center;gap:10px;background:var(--primary);color:#fff;padding:20px 32px;border-radius:16px;font-size:15px;font-weight:500;text-decoration:none;transition:transform .25s,opacity .25s;margin-bottom:48px;letter-spacing:.3px}
.contact-wa:hover{transform:translateY(-2px);opacity:.88}
.detail-list{display:flex;flex-direction:column;gap:14px}
.detail{display:flex;align-items:flex-start;gap:18px;padding:22px;background:#fff;border-radius:18px;opacity:0;transform:translateY(10px);transition:opacity .7s ease,transform .7s ease;box-shadow:0 1px 3px rgba(15,13,11,.05)}
.detail.vis{opacity:1;transform:none}
.detail-icon{font-size:20px;flex-shrink:0;margin-top:2px}
.detail-label{font-size:10px;font-weight:500;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.detail-val{font-size:15px;font-weight:300;color:var(--dark);line-height:1.5}
.detail-link{color:var(--primary);text-decoration:none}
.hours-row{display:flex;font-size:13px;font-weight:300;color:var(--dark);padding:2px 0;gap:8px}

/* ── MAP ── */
.map-frame{width:100%;height:240px;border:none;display:block;filter:grayscale(15%) contrast(1.05)}

/* ── FOOTER ── */
.footer{background:var(--dark);padding:56px 28px;text-align:center}
.footer-brand{font-family:var(--serif);font-size:20px;font-weight:300;color:#fff;margin-bottom:6px;letter-spacing:.3px}
.footer-domain{font-size:11px;color:rgba(255,255,255,.3);letter-spacing:1px;margin-bottom:28px}
.footer-links{display:flex;justify-content:center;gap:24px;margin-bottom:24px;flex-wrap:wrap}
.footer-link{font-size:11px;color:rgba(255,255,255,.35);text-decoration:none;letter-spacing:1px;text-transform:uppercase;transition:color .2s}
.footer-link:hover{color:rgba(255,255,255,.7)}
.footer-copy{font-size:10px;color:rgba(255,255,255,.15);letter-spacing:.5px}

/* ── FAB ── */
.fab-stack{position:fixed;bottom:24px;right:20px;z-index:90;display:flex;flex-direction:column;gap:10px;align-items:flex-end}
.fab-btn{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;text-decoration:none;box-shadow:0 4px 18px rgba(0,0,0,.2);transition:transform .25s,box-shadow .25s}
.fab-btn:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(0,0,0,.28)}
.fab-wa{background:#25D366}
.fab-call{background:var(--primary)}

/* ── KEYFRAMES ── */
@keyframes heroReveal{from{transform:scale(1.06)}to{transform:scale(1)}}
@keyframes wordFade{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes wordRise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}
@keyframes breathe{0%,100%{opacity:.25}50%{opacity:.7}}
@keyframes progressBar{from{width:0%}to{width:100%}}

@media(prefers-reduced-motion:reduce){
  *{animation-duration:.01ms!important;transition-duration:.01ms!important}
}
</style>
</head>
<body>

<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="nav-links">
    ${!isExp ? `<a href="#about" class="nav-link">About</a>` : ''}
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Reviews</a>` : ''}
    <a href="#contact" class="nav-link">Contact</a>
    <a href="${esc(waLink)}" class="nav-link nav-cta">WhatsApp</a>
  </div>
</nav>

<!-- ═══ HERO ═══ -->
<section class="hero" id="hero">
  <div class="hero-bg" id="heroBg">
    <div class="hero-img" id="heroImg"></div>
  </div>
  ${rating ? `
  <div class="hero-rating">
    <div class="rating-num">${rating}</div>
    <div class="rating-stars">${'★'.repeat(Math.round(rating))}${'☆'.repeat(5-Math.round(rating))}</div>
    <div class="rating-count">${reviewCount} reviews</div>
  </div>` : ''}
  <div class="hero-content">
    <div class="hero-label">${esc(domain)}</div>
    <h1 class="hero-h1" id="heroH1">${
      (t.hero_h1_line1 || client.business_name).split(' ').map((w,i) =>
        `<span class="word" style="animation-delay:${.5+i*.12}s">${esc(w)}</span> `
      ).join('')
    }${t.hero_h1_line2 ? `<br><em class="word" style="animation-delay:${.5+((t.hero_h1_line1||'').split(' ').length)*.12}s">${esc(t.hero_h1_line2)}</em>` : ''}</h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-ctas">
      <a href="${esc(waLink)}" class="btn-primary">💬 ${esc(t.hero_cta || 'WhatsApp Us')}</a>
      <a href="#${!isExp ? 'about' : 'services'}" class="btn-ghost">Discover ↓</a>
    </div>
  </div>
  <div class="scroll-whisper">
    <div class="scroll-line"></div>
    <span class="scroll-text">Scroll</span>
  </div>
</section>

<!-- ═══ MISSION RIBBON ═══ -->
${missionStatement ? `
<div class="mission" id="mission">
  <div class="mission-inner">
    <p class="mission-text" id="missionText">${esc(missionStatement)}</p>
    <div class="mission-rule" id="missionRule"></div>
  </div>
</div>` : ''}

<!-- ═══ ABOUT ═══ -->
${!isExp ? `
<section class="about" id="about">
  <div class="about-blur"></div>
  <div class="about-inner">
    <div class="eyebrow reveal" data-delay="0">${esc(t.section_label_about || 'OUR STORY')}</div>
    <h2 class="about-h2">
      <span class="line reveal" data-delay="80">${esc(t.about_headline || client.business_name)}</span>
      ${t.about_headline?.split(' ').length > 3 ? '' : `<span class="line reveal" data-delay="160"><em>${esc(t.hero_h1_line2 || '')}</em></span>`}
    </h2>
    ${t.about_pull_quote ? `<p class="about-pull reveal" data-delay="200">${esc(t.about_pull_quote)}</p>` : ''}
    ${t.about_p1 ? `<p class="about-body reveal" data-delay="260">${esc(t.about_p1)}</p>` : ''}
    ${t.about_p2 ? `<p class="about-body reveal" data-delay="320">${esc(t.about_p2)}</p>` : ''}
  </div>
</section>` : ''}

<!-- ═══ SERVICES ═══ -->
<section class="services" id="services">
  <div class="services-inner">
    <div class="eyebrow reveal" data-delay="0">${esc(t.section_label_services || 'WHAT WE OFFER')}</div>
    <h2 class="section-h2 reveal" data-delay="80">${esc(t.services_headline || 'Our offerings')}</h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-row reveal" data-delay="${i*80}">
      <div class="svc-icon">${s.icon || '✦'}</div>
      <div>
        <div class="svc-name">${esc(s.name || '')}</div>
        ${!isExp && s.desc ? `<div class="svc-desc">${esc(s.desc)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>
</section>

<!-- ═══ GALLERY — crossfade ═══ -->
${hasGallery ? `
<section class="gallery" id="gallery">
  <div class="gallery-stage" id="galleryStage">
    ${galleryPhotos.map((url, i) => `
    <div class="gallery-slide${i===0?' active':''}" data-idx="${i}">
      <img src="${esc(url)}" alt="${esc(client.business_name)}" loading="${i===0?'eager':'lazy'}">
    </div>`).join('')}
    <div class="gallery-caption">
      <div class="gallery-caption-text">${esc(client.business_name)}</div>
    </div>
    <div class="gallery-progress" id="galleryProgress"></div>
    <div class="gallery-nav" id="galleryNav">
      ${galleryPhotos.map((_,i) => `<div class="gallery-dot${i===0?' active':''}" data-idx="${i}"></div>`).join('')}
    </div>
  </div>
</section>` : ''}

<!-- ═══ REVIEWS ═══ -->
${reviews.length ? `
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <div>
        <div class="eyebrow reveal" data-delay="0">${esc(t.section_label_reviews || 'WHAT PEOPLE SAY')}</div>
        <div class="reviews-title reveal" data-delay="80">${esc(t.reviews_headline || 'Words from our guests')}<br><em></em></div>
      </div>
      ${rating ? `
      <div class="reviews-score reveal" data-delay="120">
        <div class="score-num">${rating}</div>
        <div class="score-stars">${'★'.repeat(Math.round(rating))}</div>
        <div class="score-count">${reviewCount} reviews</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-block reveal" data-delay="${i*120}">
      <p class="review-q">${esc(r.text || r.quote || '')}</p>
      <div class="review-meta">
        <span class="review-stars">${'★'.repeat(r.rating || 5)}</span>
        <span>${esc(r.author || r.name || 'Guest')}</span>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

<!-- ═══ WHY US ═══ -->
${(t.diff1_title || t.whyus_items?.length) && !isExp ? `
<section class="whyus" id="whyus">
  <div class="whyus-inner">
    <div class="eyebrow reveal" data-delay="0" style="color:var(--accent)">${esc(t.section_label_whyus || 'WHY US')}</div>
    <h2 class="section-h2 reveal" data-delay="80" style="color:#fff">${esc(t.whyus_headline || '')}</h2>
    ${(t.whyus_items || [
      {title: t.diff1_title, body: t.diff1_body},
      {title: t.diff2_title, body: t.diff2_body},
      {title: t.diff3_title, body: t.diff3_body},
    ]).filter(d=>d?.title).map((d,i) => `
    <div class="why-item reveal" data-delay="${i*100}">
      <div class="why-num">0${i+1}</div>
      <div class="why-title">${esc(d.title)}</div>
      <div class="why-body">${esc(d.body || '')}</div>
    </div>`).join('')}
  </div>
</section>` : ''}

<!-- ═══ FULL QUOTE ═══ -->
${t.testimonial_quote ? `
<section class="full-quote">
  <div class="quote-inner reveal" data-delay="0">
    <p class="quote-text">${esc(t.testimonial_quote)}</p>
    <div class="quote-name">${esc(t.testimonial_name || '')}</div>
    ${t.testimonial_context ? `<div class="quote-ctx">${esc(t.testimonial_context)}</div>` : ''}
  </div>
</section>` : ''}

<!-- ═══ CONTACT ═══ -->
<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="eyebrow reveal" data-delay="0">${esc(t.section_label_contact || 'COME SEE US')}</div>
    <h2 class="contact-h2 reveal" data-delay="80">${esc(t.contact_headline || 'Come find us')}</h2>
    <p class="contact-sub reveal" data-delay="140">${esc(t.contact_subline || '')}</p>
    <a href="${esc(waLink)}" class="contact-wa">
      <span>💬</span> ${esc(t.contact_cta || 'WhatsApp Us')}
    </a>
    <div class="detail-list">
      ${client.phone ? `
      <div class="detail reveal" data-delay="0">
        <div class="detail-icon">📞</div>
        <div>
          <div class="detail-label">Call us</div>
          <a href="tel:${esc(client.phone)}" class="detail-val detail-link">${esc(phoneDisplay)}</a>
        </div>
      </div>` : ''}
      ${address ? `
      <div class="detail reveal" data-delay="80">
        <div class="detail-icon">📍</div>
        <div>
          <div class="detail-label">Find us</div>
          <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="detail-val detail-link">${esc(address)}</a>
        </div>
      </div>` : ''}
      ${hours.length ? `
      <div class="detail reveal" data-delay="160">
        <div class="detail-icon">🕐</div>
        <div>
          <div class="detail-label">Hours</div>
          <div class="detail-val">${hours.slice(0,5).map(h=>`<div class="hours-row">${esc(h)}</div>`).join('')}</div>
        </div>
      </div>` : ''}
    </div>
  </div>
</section>

<!-- ═══ MAP ═══ -->
${address ? `
<iframe class="map-frame" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
  src="https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed"
  title="Find ${esc(client.business_name)}"></iframe>` : ''}

${client.cross_link_url ? `
<div style="background:rgba(0,240,255,.07);border-top:1px solid rgba(0,240,255,.12);padding:18px 24px;text-align:center">
  <a href="${esc(client.cross_link_url)}" style="color:var(--primary);font-family:var(--serif);font-size:14px;font-weight:400;text-decoration:none;letter-spacing:.3px">
    ${esc(client.cross_link_text || '🏡 Visit our sister property →')}
  </a>
</div>` : ''}

<footer class="footer">
  <div class="footer-brand">${esc(t.short_name || client.business_name)}</div>
  <div class="footer-domain">${esc(domain)}</div>
  <div class="footer-links">
    <a href="${esc(waLink)}" class="footer-link">WhatsApp</a>
    ${client.instagram ? `<a href="https://instagram.com/${esc((client.instagram||'').replace('@',''))}" class="footer-link" target="_blank">Instagram</a>` : ''}
    ${client.facebook ? `<a href="https://facebook.com/${esc(client.facebook||'')}" class="footer-link" target="_blank">Facebook</a>` : ''}
    <a href="https://websitehub.co.za" class="footer-link" target="_blank">Powered by Website Hub</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} ${esc(client.business_name)}</div>
</footer>

${phone ? `
<div class="fab-stack">
  <a href="tel:${esc(phone)}" class="fab-btn fab-call" aria-label="Call">📞</a>
  <a href="${esc(waLink)}" class="fab-btn fab-wa" aria-label="WhatsApp">💬</a>
</div>` : `
<a href="${esc(waLink)}" class="fab-btn fab-wa" style="position:fixed;bottom:24px;right:20px;z-index:90" aria-label="WhatsApp">💬</a>`}

<script>
// ── Licence guard ──
(function(){
  var s='${esc(client.slug)}';
  var ok=['preview.websitehub.co.za','localhost','127.0.0.1',s+'.websitehub.co.za',s+'.co.za'];
  var h=location.hostname.toLowerCase();
  if(!ok.some(function(d){return h===d||h.endsWith('.'+d)})){location.replace('https://websitehub.co.za')}
})();

// ── Nav scroll ──
var nav=document.getElementById('nav');
window.addEventListener('scroll',function(){nav.classList.toggle('scrolled',scrollY>60)},{passive:true});

// ── Parallax hero ──
var heroImg=document.getElementById('heroImg');
if(heroImg && window.matchMedia('(prefers-reduced-motion:no-preference)').matches){
  window.addEventListener('scroll',function(){
    var y=scrollY*0.28;
    heroImg.style.transform='scale(1) translateY('+y+'px)';
  },{passive:true});
}

// ── Scroll reveal ──
var obs=new IntersectionObserver(function(entries){
  entries.forEach(function(e){
    if(e.isIntersecting){
      var el=e.target;
      var delay=parseInt(el.dataset.delay||0);
      setTimeout(function(){
        el.classList.add('vis');
      },delay);
      obs.unobserve(el);
    }
  });
},{threshold:0.1,rootMargin:'0px 0px -50px 0px'});

// Mission
var mt=document.getElementById('missionText');
var mr=document.getElementById('missionRule');
if(mt){
  var mObs=new IntersectionObserver(function(entries){
    if(entries[0].isIntersecting){mt.classList.add('vis');if(mr)mr.classList.add('vis');mObs.disconnect()}
  },{threshold:0.2});
  mObs.observe(mt);
}

// All reveal elements
document.querySelectorAll('.reveal,.eyebrow,.about-h2 .line,.about-pull,.about-body,.section-h2,.service-row,.review-block,.why-item,.quote-inner,.contact-h2,.contact-sub,.detail,.gallery-header,.reviews-score').forEach(function(el){
  obs.observe(el);
});

// ── Gallery crossfade ──
var slides=document.querySelectorAll('.gallery-slide');
var dots=document.querySelectorAll('.gallery-dot');
var progressBar=document.getElementById('galleryProgress');
var current=0;
var timer=null;
var DURATION=4800;

function showSlide(idx){
  slides.forEach(function(s,i){s.classList.toggle('active',i===idx)});
  dots.forEach(function(d,i){d.classList.toggle('active',i===idx)});
  current=idx;
  if(progressBar){
    progressBar.style.transition='none';
    progressBar.style.width='0%';
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        progressBar.style.transition='width '+DURATION+'ms linear';
        progressBar.style.width='100%';
      });
    });
  }
}

function nextSlide(){
  showSlide((current+1)%slides.length);
}

if(slides.length>1){
  showSlide(0);
  timer=setInterval(nextSlide,DURATION);
  dots.forEach(function(d){
    d.addEventListener('click',function(){
      clearInterval(timer);
      showSlide(parseInt(d.dataset.idx));
      timer=setInterval(nextSlide,DURATION);
    });
  });
}

// ── Counters ──
(function(){
  var s='${esc(client.slug)}';
  if(!s)return;
  new Image().src='/'+s+'/ping';
  document.querySelectorAll('a[href*="wa.me"]').forEach(function(a){
    a.addEventListener('click',function(){new Image().src='/'+s+'/wa'},{once:true,passive:true});
  });
})();
</script>
</body>
</html>`;
}
