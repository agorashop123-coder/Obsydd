# OBSYD: going live with payments

This folder is the whole shop. Customers fill in their address on your site, then pay on a secure Stripe page. Their card details never touch your site.

    index.html                    the website (prices, products, delivery prices live here)
    images/                       product photos (also embedded in index.html)
    netlify/functions/checkout.js the payment function: it reads your prices from index.html and creates the Stripe payment page
    netlify.toml                  Netlify settings

## 1. Put the site online (Netlify)
Drag-and-drop uploads do NOT run the payment function, so deploy from Git:
1. Create a private GitHub repository and upload this folder's contents (everything except the .zip).
2. On netlify.com: Add new site, Import an existing project, pick the repository. Leave the build settings empty and deploy.
   (Alternative: `npm i -g netlify-cli`, then `netlify deploy --prod` inside this folder.)

## 2. Connect Stripe
1. Create an account on stripe.com and finish the business verification. Stripe requires it before paying you out.
2. Settings, Payment methods: switch on Cards, Bancontact, iDEAL, Apple Pay, Google Pay (whatever you want to offer).
3. Developers, API keys: copy the Secret key. While testing it starts with `sk_test_`.
4. Netlify, Site configuration, Environment variables: add `STRIPE_SECRET_KEY` with that key. Then Deploys, Trigger deploy.
   Never write the key in index.html or commit it to GitHub.

## 3. Test before real customers
1. Open your Netlify address, add a jacket, choose Check out, fill in the address, press Pay.
2. On the Stripe page pay with the test card 4242 4242 4242 4242 (any future date, any 3 digits).
3. You come back to the site with a thank-you banner. In Stripe, Payments shows the payment, the delivery address and the order (in the details, under Metadata). In Netlify, Forms, "order" shows the same order and address.
4. Try 3 items (delivery becomes free) and a country outside Belgium (delivery is 9.95).

## 4. Go live
Replace `STRIPE_SECRET_KEY` with the live key (`sk_live_...`), redeploy, and make one small real payment yourself. Refund it from the Stripe Dashboard.

## Things you change in index.html
- Prices and sale price: the `PRODUCTS` list. The payment function reads the same list, so the site and the payment can never disagree.
- `SALE_ENDS`: when the sale stops. After that date everything is charged at full price, on the site and in Stripe.
- `SHIPPING`: delivery price for Belgium (BE) and every other country.
- `FREE_FROM_ITEMS`: delivery is free from this many items (3).
- `COUNTRIES`: the countries you deliver to.

## Before you launch (Belgium / EU)
- Terms and conditions, returns policy (customers have a 14-day right of withdrawal), privacy policy and your company details on the site.
- A cookie banner: the TikTok videos load TikTok's player, which needs consent in the EU.
- Only sell branded clothing (Nike, Alo, national team crests) if it is genuine or you have permission.
