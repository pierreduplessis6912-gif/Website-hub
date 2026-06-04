/**
 * EXPERIENCE ARCHETYPE — The World You Step Into
 *
 * For: restaurant, salon, spa, bakery, florist, coffee shop, lodge,
 *      guest house, wedding, event venue, lashes, massage, beauty
 *
 * Feel: Immersive. Sensory. You are already there before you read a word.
 *       A field of daffodils. The smell of fresh bread. The sound of rain
 *       on a garden. Content bleeds between sections like memory bleeds
 *       into memory. Reviews whisper. The contact section says "come see us"
 *       and you already want to.
 */

export function generateExperienceHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone   = (client.phone || '').replace(/\D/g, '');
  const domain  = client.domain || `${client.slug}.co.za`;
  const waLink  = `https://wa.me/${phone}`;
  const isExp   = pkg === 'express';
  const isPrem  = pkg === 'premium';

  const primary = brandBrief?.primary_colour || '#c8a96e';
  const accent  = brandBrief?.accent_colour  || '#e8d5a3';
  const svcs    = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';

  const phoneDisplay = (client.phone || '').replace(/^\+?27/, '0').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── PARTICLE SYSTEM — industry aware ─────────────────────────
  const industry = (cards?.industry || client.industry || '').toLowerCase();
  const particleType =
    /florist|flower|nursery|garden|plant/.test(industry)   ? 'petals'     :
    /wedding|event|venue/.test(industry)                    ? 'confetti'   :
    /lodge|guest.house|airbnb|camp/.test(industry)          ? 'fireflies'  :
    /spa|massage|yoga|pilates|wellness/.test(industry)      ? 'orbs'       :
    /tattoo|piercing/.test(industry)                        ? 'none'       :
    /restaurant|bakery|cafe|coffee|food/.test(industry)     ? 'none'       :
    'none'; // default — most businesses look better without particles

  const particleCSS = particleType === 'petals' ? `
.particle{position:absolute;background:var(--accent);border-radius:50% 50% 50% 0;opacity:0;animation:petalFloat linear infinite;pointer-events:none}
${Array.from({length:8},(_,i)=>`.particle:nth-child(${i+1}){left:${10+i*11}%;animation-duration:${12+i*2.3}s;animation-delay:${i*1.7}s;width:${5+i%3}px;height:${8+i%4}px}`).join('\n')}
@keyframes petalFloat{0%{transform:translateY(100vh) rotate(0deg);opacity:0}5%{opacity:.6}90%{opacity:.4}100%{transform:translateY(-20vh) rotate(720deg) translateX(40px);opacity:0}}` :

  particleType === 'fireflies' ? `
.particle{position:absolute;width:4px;height:4px;background:var(--accent);border-radius:50%;opacity:0;animation:fireflyFloat ease-in-out infinite;pointer-events:none;box-shadow:0 0 6px var(--accent)}
${Array.from({length:10},(_,i)=>`.particle:nth-child(${i+1}){left:${5+i*9}%;top:${20+i*6}%;animation-duration:${6+i*1.5}s;animation-delay:${i*0.8}s}`).join('\n')}
@keyframes fireflyFloat{0%,100%{opacity:0;transform:translate(0,0)}25%{opacity:.8;transform:translate(${Math.random()>0.5?'':'-'}12px,-8px)}50%{opacity:.4;transform:translate(8px,4px)}75%{opacity:.7;transform:translate(-6px,-12px)}}` :

  particleType === 'orbs' ? `
.particle{position:absolute;border-radius:50%;background:radial-gradient(circle,var(--accent),transparent);opacity:0;animation:orbFloat ease-in-out infinite;pointer-events:none}
${Array.from({length:5},(_,i)=>`.particle:nth-child(${i+1}){width:${40+i*20}px;height:${40+i*20}px;left:${10+i*18}%;top:${30+i*8}%;animation-duration:${8+i*2}s;animation-delay:${i*1.2}s}`).join('\n')}
@keyframes orbFloat{0%,100%{opacity:0;transform:translateY(0)}50%{opacity:.15;transform:translateY(-20px)}}` :

  particleType === 'confetti' ? `
.particle{position:absolute;width:6px;height:6px;opacity:0;animation:confettiFall linear infinite;pointer-events:none}
${Array.from({length:12},(_,i)=>`.particle:nth-child(${i+1}){left:${i*8}%;background:${['var(--primary)','var(--accent)','#fff'][i%3]};border-radius:${i%2?'50%':'2px'};animation-duration:${8+i*1.2}s;animation-delay:${i*0.6}s}`).join('\n')}
@keyframes confettiFall{0%{transform:translateY(-20px) rotate(0deg);opacity:0}10%{opacity:.8}90%{opacity:.5}100%{transform:translateY(100vh) rotate(720deg);opacity:0}}` :
  ''; // none

  const particleElements = particleType !== 'none'
    ? Array.from({length: particleType === 'confetti' ? 12 : particleType === 'fireflies' ? 10 : 8}, () => `<div class="particle"></div>`).join('')
    : '';

  const botanicalLeaves = Array.from({length:6}, (_,i) =>
    `<ellipse cx="${70+i*10}" cy="${320-i*40}" rx="${8+i*2}" ry="${4+i}" fill="white" opacity="${(0.2+i*0.05).toFixed(2)}" transform="rotate(${-20+i*8} ${70+i*10} ${320-i*40})"/>`
  ).join('');

  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);

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
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --dark:#0e0c09;
  --dark2:#1a1612;
  --warm-white:#faf7f2;
  --cream:#f5f0e8;
  --muted:#8a7d6e;
  --font-display:'Cormorant Garamond',Georgia,serif;
  --font-body:'Jost',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--warm-white);color:var(--dark);overflow-x:hidden}

/* NAV */
.nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:20px 28px;transition:background .4s,backdrop-filter .4s}
.nav.scrolled{background:rgba(14,12,9,.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.nav-brand{font-family:var(--font-display);font-size:18px;font-weight:400;color:#fff;letter-spacing:.5px;text-decoration:none}
.nav-links{display:flex;align-items:center;gap:24px}
.nav-link{color:rgba(255,255,255,.8);font-size:13px;font-weight:400;letter-spacing:.5px;text-decoration:none;transition:color .2s}
.nav-link:hover{color:#fff}
.nav-wa{background:var(--primary);color:var(--dark)!important;padding:9px 18px;border-radius:100px;font-weight:600}

/* HERO */
.hero{position:relative;height:100svh;min-height:600px;display:flex;flex-direction:column;justify-content:flex-end;padding:0 28px 80px;overflow:hidden}
.hero-bg{position:absolute;inset:0;background-image:url('${esc(heroUrl)}');background-size:cover;background-position:center;transform:scale(1.08);animation:heroReveal 1.8s cubic-bezier(.16,1,.3,1) forwards}
.hero-bg::after{content:'';position:absolute;inset:0;background:linear-gradient(to bottom,rgba(14,12,9,.1) 0%,rgba(14,12,9,.2) 40%,rgba(14,12,9,.78) 100%)}
.hero-content{position:relative;z-index:2}
.hero-label{font-family:var(--font-body);font-size:11px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:var(--accent);margin-bottom:16px;animation:fadeUp .8s .4s ease both}
.hero-h1{font-family:var(--font-display);font-size:clamp(52px,13vw,88px);font-weight:300;line-height:1;letter-spacing:-1px;color:#fff;margin-bottom:20px;animation:fadeUp .8s .55s ease both}
.hero-h1 em{font-style:italic;color:var(--accent)}
.hero-subline{font-size:16px;font-weight:300;color:rgba(255,255,255,.8);line-height:1.6;max-width:400px;margin-bottom:36px;animation:fadeUp .8s .7s ease both}
.hero-ctas{display:flex;gap:14px;flex-wrap:wrap;animation:fadeUp .8s .85s ease both}
.btn-primary{background:var(--primary);color:var(--dark);padding:14px 28px;border-radius:100px;font-size:14px;font-weight:600;letter-spacing:.3px;text-decoration:none;transition:transform .2s,opacity .2s;display:inline-flex;align-items:center;gap:8px}
.btn-primary:hover{transform:translateY(-1px);opacity:.9}
.btn-ghost{border:1.5px solid rgba(255,255,255,.35);color:#fff;padding:14px 28px;border-radius:100px;font-size:14px;font-weight:400;text-decoration:none;transition:all .2s}
.btn-ghost:hover{border-color:rgba(255,255,255,.7);background:rgba(255,255,255,.08)}
.hero-rating{position:absolute;bottom:88px;right:24px;background:rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:12px 14px;text-align:center;z-index:2;animation:fadeIn 1s 1.2s ease both;min-width:80px}
.rating-num{font-family:var(--font-display);font-size:28px;font-weight:300;color:#fff;line-height:1}
.rating-stars{color:var(--accent);font-size:12px;margin:4px 0}
.rating-count{font-size:11px;color:rgba(255,255,255,.6)}
.scroll-hint{position:absolute;bottom:32px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;z-index:2;animation:fadeIn 1s 2s ease both}
.scroll-hint-line{width:1px;height:40px;background:linear-gradient(to bottom,rgba(255,255,255,.5),transparent);animation:scrollPulse 2s infinite}
.scroll-hint-text{font-size:10px;letter-spacing:2px;color:rgba(255,255,255,.4);text-transform:uppercase}

/* INTRO RIBBON */
.intro-ribbon{background:var(--cream);padding:48px 28px;overflow:hidden}
.intro-ribbon-inner{max-width:680px;margin:0 auto;text-align:center}
.intro-ribbon-text{font-family:var(--font-display);font-size:clamp(22px,5vw,32px);font-weight:300;font-style:italic;color:var(--dark);line-height:1.4;opacity:0;transform:translateY(20px);transition:opacity .8s ease,transform .8s ease}
.intro-ribbon-text.visible{opacity:1;transform:none}

/* ABOUT */
.about{position:relative;background:var(--dark);padding:100px 28px;overflow:hidden}
.about-botanical{position:absolute;right:-60px;top:50%;transform:translateY(-50%);width:55vw;max-width:380px;opacity:.07;pointer-events:none}
.about-inner{position:relative;z-index:2;max-width:560px}
.section-label{font-size:10px;font-weight:600;letter-spacing:4px;text-transform:uppercase;color:var(--primary);margin-bottom:20px;opacity:0;transform:translateY(12px);transition:opacity .6s ease,transform .6s ease}
.section-label.visible{opacity:1;transform:none}
.about-headline{font-family:var(--font-display);font-size:clamp(36px,8vw,58px);font-weight:300;line-height:1.1;letter-spacing:-.5px;color:#fff;margin-bottom:28px;opacity:0;transform:translateY(20px);transition:opacity .8s .1s ease,transform .8s .1s ease}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{font-style:italic;color:var(--accent)}
.about-pull{font-family:var(--font-display);font-size:clamp(18px,4vw,24px);font-style:italic;font-weight:300;color:var(--accent);line-height:1.5;margin-bottom:28px;padding-left:20px;border-left:2px solid var(--primary);opacity:0;transform:translateY(16px);transition:opacity .8s .2s ease,transform .8s .2s ease}
.about-pull.visible{opacity:1;transform:none}
.about-body{font-size:15px;font-weight:300;color:rgba(255,255,255,.7);line-height:1.8;margin-bottom:16px;opacity:0;transform:translateY(12px);transition:opacity .8s .3s ease,transform .8s .3s ease}
.about-body.visible{opacity:1;transform:none}

/* SERVICES */
.services{background:var(--warm-white);padding:100px 28px}
.services-inner{max-width:680px;margin:0 auto}
.section-headline{font-family:var(--font-display);font-size:clamp(32px,7vw,52px);font-weight:300;line-height:1.15;letter-spacing:-.3px;color:var(--dark);margin-bottom:48px;opacity:0;transform:translateY(20px);transition:opacity .8s ease,transform .8s ease}
.section-headline.visible{opacity:1;transform:none}
.service-item{display:flex;align-items:flex-start;gap:20px;padding:28px 0;border-bottom:1px solid rgba(14,12,9,.1);opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s ease}
.service-item:last-child{border-bottom:none}
.service-item.visible{opacity:1;transform:none}
.service-icon{font-size:24px;flex-shrink:0;width:48px;height:48px;background:var(--cream);border-radius:50%;display:flex;align-items:center;justify-content:center}
.service-name{font-family:var(--font-display);font-size:20px;font-weight:400;color:var(--dark);margin-bottom:4px}
.service-desc{font-size:14px;font-weight:300;color:var(--muted);line-height:1.6}

/* REVIEWS */
.reviews{background:var(--dark2);padding:100px 28px;position:relative;overflow:hidden}
.reviews::before{content:'';position:absolute;top:0;left:0;right:0;height:120px;background:linear-gradient(to bottom,var(--warm-white),transparent);opacity:.05;pointer-events:none}
.reviews-inner{max-width:680px;margin:0 auto}
.reviews-header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:56px;flex-wrap:wrap;gap:16px}
.reviews-title{font-family:var(--font-display);font-size:clamp(28px,6vw,44px);font-weight:300;color:#fff;line-height:1.1}
.reviews-title em{font-style:italic;color:var(--accent)}
.reviews-rating-num{font-family:var(--font-display);font-size:48px;font-weight:300;color:var(--accent);line-height:1}
.reviews-rating-stars{color:var(--accent);font-size:14px;margin:4px 0}
.reviews-rating-count{font-size:12px;color:rgba(255,255,255,.4)}
.review-item{padding:40px 0;border-bottom:1px solid rgba(255,255,255,.08);opacity:0;transform:translateX(-24px);transition:opacity .8s ease,transform .8s ease}
.review-item:last-child{border-bottom:none}
.review-item.visible{opacity:1;transform:none}
.review-quote{font-family:var(--font-display);font-size:clamp(18px,4vw,24px);font-weight:300;font-style:italic;color:rgba(255,255,255,.9);line-height:1.5;margin-bottom:16px}
.review-quote::before{content:'\u201C';font-size:1.5em;color:var(--primary);vertical-align:-.15em;margin-right:4px}
.review-quote::after{content:'\u201D';font-size:1.5em;color:var(--primary);vertical-align:-.15em;margin-left:4px}
.review-attr{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:12px}
.review-attr-stars{color:var(--accent)}

/* WHY US */
.whyus{background:var(--cream);padding:100px 28px}
.whyus-inner{max-width:680px;margin:0 auto}
.diff-item{padding:36px 0;border-bottom:1px solid rgba(14,12,9,.1);opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s ease}
.diff-item:last-child{border-bottom:none}
.diff-item.visible{opacity:1;transform:none}
.diff-num{font-family:var(--font-display);font-size:11px;font-weight:400;letter-spacing:3px;color:var(--primary);margin-bottom:8px;text-transform:uppercase}
.diff-title{font-family:var(--font-display);font-size:clamp(22px,5vw,32px);font-weight:400;color:var(--dark);margin-bottom:10px}
.diff-body{font-size:15px;font-weight:300;color:var(--muted);line-height:1.7}

/* TESTIMONIAL */
.testimonial{background:var(--dark);padding:120px 28px;text-align:center;position:relative;overflow:hidden}
.testimonial::before{content:'\u201C';position:absolute;top:-20px;left:50%;transform:translateX(-50%);font-family:var(--font-display);font-size:300px;font-weight:300;color:rgba(255,255,255,.03);line-height:1;pointer-events:none;user-select:none}
.testimonial-inner{position:relative;z-index:2;max-width:580px;margin:0 auto;opacity:0;transform:translateY(24px);transition:opacity 1s ease,transform 1s ease}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{font-family:var(--font-display);font-size:clamp(22px,5vw,34px);font-weight:300;font-style:italic;color:#fff;line-height:1.5;margin-bottom:32px}
.testimonial-name{font-size:12px;font-weight:500;letter-spacing:2px;text-transform:uppercase;color:var(--primary)}
.testimonial-context{font-size:12px;font-weight:300;color:rgba(255,255,255,.4);margin-top:4px}

/* GALLERY */
.gallery{background:var(--dark2);padding:80px 0}
.gallery-header{padding:0 28px 48px;opacity:0;transform:translateY(16px);transition:opacity .8s ease,transform .8s ease}
.gallery-header.visible{opacity:1;transform:none}
.gallery-title{font-family:var(--font-display);font-size:clamp(28px,6vw,44px);font-weight:300;color:#fff}
.gallery-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3px}
.gallery-img{aspect-ratio:1;object-fit:cover;width:100%;display:block;opacity:0;transition:opacity .6s ease,transform .4s ease}
.gallery-img.visible{opacity:1}
.gallery-img:hover{transform:scale(1.03)}

/* CONTACT */
.contact{background:var(--warm-white);padding:100px 28px}
.contact-inner{max-width:680px;margin:0 auto}
.contact-headline{font-family:var(--font-display);font-size:clamp(36px,8vw,60px);font-weight:300;line-height:1.1;letter-spacing:-.5px;color:var(--dark);margin-bottom:12px;opacity:0;transform:translateY(20px);transition:opacity .8s ease,transform .8s ease}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{font-style:italic;color:var(--primary)}
.contact-subline{font-size:16px;font-weight:300;color:var(--muted);line-height:1.6;margin-bottom:48px;opacity:0;transform:translateY(12px);transition:opacity .8s .1s ease,transform .8s .1s ease}
.contact-subline.visible{opacity:1;transform:none}
.contact-actions{display:flex;flex-direction:column;gap:14px;margin-bottom:48px;opacity:0;transform:translateY(12px);transition:opacity .8s .2s ease,transform .8s .2s ease}
.contact-actions.visible{opacity:1;transform:none}
.contact-wa{background:var(--primary);color:var(--dark);padding:18px 28px;border-radius:16px;font-size:16px;font-weight:600;text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;gap:10px;transition:transform .2s,opacity .2s}
.contact-wa:hover{transform:translateY(-1px);opacity:.9}
.contact-details{display:flex;flex-direction:column;gap:16px}
.contact-detail{display:flex;align-items:flex-start;gap:16px;padding:20px;background:var(--cream);border-radius:16px;opacity:0;transform:translateY(12px);transition:opacity .6s ease,transform .6s ease}
.contact-detail.visible{opacity:1;transform:none}
.contact-detail-icon{font-size:20px;flex-shrink:0;margin-top:2px}
.contact-detail-label{font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.contact-detail-value{font-size:15px;font-weight:400;color:var(--dark);line-height:1.5}
.contact-detail-link{color:var(--primary);text-decoration:none}
.hours-grid{display:flex;flex-direction:column;gap:2px}
.hours-row{display:flex;font-size:13px;font-weight:300;color:var(--dark);padding:3px 0}

/* FOOTER */
.footer{background:var(--dark);padding:48px 28px;text-align:center}
.footer-brand{font-family:var(--font-display);font-size:22px;font-weight:300;color:#fff;margin-bottom:8px}
.footer-domain{font-size:12px;color:var(--muted);letter-spacing:.5px;margin-bottom:24px}
.footer-links{display:flex;justify-content:center;gap:20px;margin-bottom:20px;flex-wrap:wrap}
.footer-link{font-size:12px;color:rgba(255,255,255,.4);text-decoration:none;letter-spacing:.5px;transition:color .2s}
.footer-link:hover{color:var(--accent)}
.footer-copy{font-size:11px;color:rgba(255,255,255,.2)}

/* WA FLOAT */{position:fixed;bottom:24px;right:24px;z-index:90;background:#25D366;color:#fff;width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;text-decoration:none;box-shadow:0 4px 20px rgba(37,211,102,.4);transition:transform .2s}
.wa-float:hover{transform:scale(1.08)}

/* ANIMATIONS */
@keyframes heroReveal{from{transform:scale(1.08)}to{transform:scale(1)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes scrollPulse{0%,100%{opacity:.3}50%{opacity:.8}}
${particleCSS}
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
    <a href="${esc(waLink)}" class="nav-link nav-wa">WhatsApp</a>
  </div>
</nav>

<section class="hero">
  ${particleElements}
  <div class="hero-bg"></div>
  ${rating ? `
  <div class="hero-rating">
    <div class="rating-num">${rating}</div>
    <div class="rating-stars">${'★'.repeat(Math.round(rating))}${'☆'.repeat(5-Math.round(rating))}</div>
    <div class="rating-count">${reviewCount} reviews</div>
  </div>` : ''}
  <div class="hero-content">
    <div class="hero-label">${esc(domain.toUpperCase())}</div>
    <h1 class="hero-h1">${esc(t.hero_h1_line1 || '')}${t.hero_h1_line2 ? `<br><em>${esc(t.hero_h1_line2)}</em>` : ''}</h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-ctas">
      <a href="${esc(waLink)}" class="btn-primary">💬 ${esc(t.hero_cta || 'WhatsApp Us')}</a>
      <a href="#${!isExp ? 'about' : 'services'}" class="btn-ghost">Our story ↓</a>
    </div>
  </div>
  <div class="scroll-hint">
    <div class="scroll-hint-line"></div>
    <span class="scroll-hint-text">Scroll</span>
  </div>
</section>

<div class="intro-ribbon">
  <div class="intro-ribbon-inner">
    <p class="intro-ribbon-text">${esc(t.about_pull_quote || t.hero_trust_line || '')}</p>
  </div>
</div>

${!isExp ? `
<section class="about" id="about">
  <svg class="about-botanical" viewBox="0 0 200 400" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M100 380 Q80 300 60 250 Q40 200 50 150 Q60 100 100 80 Q140 100 150 150 Q160 200 140 250 Q120 300 100 380Z" fill="white"/>
    <path d="M100 280 Q60 260 40 220 Q20 180 40 150 Q60 120 100 130 Q140 120 160 150 Q180 180 160 220 Q140 260 100 280Z" fill="white" opacity=".6"/>
    <path d="M100 200 Q70 180 60 150 Q50 120 70 100 Q90 80 100 90 Q110 80 130 100 Q150 120 140 150 Q130 180 100 200Z" fill="white" opacity=".4"/>
    <line x1="100" y1="380" x2="100" y2="80" stroke="white" stroke-width="1.5" opacity=".3"/>
    ${botanicalLeaves}
  </svg>
  <div class="about-inner">
    <div class="section-label">${esc(t.section_label_about || 'OUR STORY')}</div>
    <h2 class="about-headline">${esc(t.about_headline || '')}${t.about_headline?.includes('em>') ? '' : ''}</h2>
    <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    <p class="about-body">${esc(t.about_p1 || '')}</p>
    ${t.about_p2 ? `<p class="about-body" style="transition-delay:.4s">${esc(t.about_p2)}</p>` : ''}
  </div>
</section>` : ''}

<section class="services" id="services">
  <div class="services-inner">
    <div class="section-label" style="color:var(--primary)">${esc(t.section_label_services || 'WHAT WE OFFER')}</div>
    <h2 class="section-headline">${esc(t.services_headline || '')}</h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-item" style="transition-delay:${i*.1}s">
      <div class="service-icon">${s.icon || '✦'}</div>
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
      <h2 class="reviews-title">What they <em>say about us</em></h2>
      ${rating ? `
      <div style="text-align:right">
        <div class="reviews-rating-num">${rating}</div>
        <div class="reviews-rating-stars">${'★'.repeat(Math.round(rating))}</div>
        <div class="reviews-rating-count">${reviewCount} Google reviews</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-item" style="transition-delay:${i*.15}s">
      <p class="review-quote">${esc(r.text || '')}</p>
      <div class="review-attr">
        <span class="review-attr-stars">${'★'.repeat(r.rating || 5)}</span>
        <span>${esc(r.author || '')}</span>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-label" style="color:var(--primary)">${esc(t.section_label_whyus || 'WHY CHOOSE US')}</div>
    <h2 class="section-headline">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-item" style="transition-delay:${i*.12}s">
      <div class="diff-num">0${i+1}</div>
      <div class="diff-title">${esc(d.title)}</div>
      <div class="diff-body">${esc(d.body || '')}</div>
    </div>`).join('')}
  </div>
</section>` : ''}

${t.testimonial_quote && !isExp ? `
<section class="testimonial">
  <div class="testimonial-inner">
    <p class="testimonial-quote">${esc(t.testimonial_quote)}</p>
    <div class="testimonial-name">${esc(t.testimonial_name || '')}</div>
    <div class="testimonial-context">${esc(t.testimonial_context || '')}</div>
  </div>
</section>` : ''}

${isPrem && galleryPhotos.length ? `
<section class="gallery" id="gallery">
  <div class="gallery-header">
    <div class="section-label" style="color:var(--accent)">${esc(t.section_label_gallery || 'OUR WORK')}</div>
    <h2 class="gallery-title">See it for yourself</h2>
  </div>
  <div class="gallery-grid">
    ${galleryPhotos.map(url => `<img class="gallery-img" src="${esc(url)}" alt="${esc(client.business_name)}" loading="lazy">`).join('')}
  </div>
</section>` : ''}

<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="section-label" style="color:var(--primary)">${esc(t.section_label_contact || 'COME SEE US')}</div>
    <h2 class="contact-headline">${esc(t.contact_headline || 'Come see us')}</h2>
    <p class="contact-subline">${esc(t.contact_subline || '')}</p>
    <div class="contact-actions">
      <a href="${esc(waLink)}" class="contact-wa">💬 ${esc(t.contact_cta || 'WhatsApp Us')}</a>
    </div>
    <div class="contact-details">
      ${client.phone ? `
      <div class="contact-detail">
        <div class="contact-detail-icon">📞</div>
        <div>
          <div class="contact-detail-label">Call us</div>
          <a href="tel:${esc(client.phone)}" class="contact-detail-value contact-detail-link">${esc(client.phone)}</a>
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
          <div class="hours-grid">${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
        </div>
      </div>` : ''}
      ${gbpData?.payment?.acceptsCreditCards ? `
      <div class="contact-detail" style="transition-delay:.3s">
        <div class="contact-detail-icon">💳</div>
        <div>
          <div class="contact-detail-label">Payment</div>
          <div class="contact-detail-value">Card${gbpData.payment.acceptsDebitCards ? ', debit' : ''}, cash accepted</div>
        </div>
      </div>` : ''}
    </div>
  </div>
</section>

<footer class="footer">
  <div class="footer-brand">${esc(t.short_name || client.business_name)}</div>
  <div class="footer-domain">${esc(domain)}</div>
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
},{threshold:0.12,rootMargin:'0px 0px -40px 0px'});

document.querySelectorAll('.section-label,.about-headline,.about-pull,.about-body,.section-headline,.service-item,.review-item,.diff-item,.testimonial-inner,.contact-headline,.contact-subline,.contact-actions,.contact-detail,.gallery-img,.gallery-header,.intro-ribbon-text').forEach(el=>obs.observe(el));

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
