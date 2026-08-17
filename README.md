# Studio Couverture AI

A commercial book cover generator for Amazon KDP (ebook & print), built with vanilla HTML/CSS/JS, Tailwind CSS, Firebase, and Stripe.

- 📐 Automatic KDP spine width & bleed calculator (6x9, 5x8, 5.5x8.5)
- 🎨 4 genre presets (Fantasy, Thriller, Romance, Sci-Fi) with dedicated typography
- 🖼️ 2D, 3D, and full print-spread previews
- 🤖 AI cover illustration generation (Gemini/Imagen via a secure Cloudflare Worker — no Firebase billing upgrade required)
- 💳 Stripe-powered credit packs for the AI generation feature
- ₿ Optional crypto payments (NOWPayments) as an alternative to card — great for regions with limited card access
- 📤 PNG (ebook) and 300 DPI PDF (print) export
- 🔒 No external CDN calls — all fonts and libraries are bundled locally

See **DOCUMENTATION.html** for full setup instructions (Firebase, Stripe, Gemini API).

Runs immediately in Demo Mode with zero configuration — no backend required to preview the design.
