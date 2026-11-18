// Framework, CMS, analytics, auth and build tool signatures and detection.

export type FrameworkCategory =
  | "framework"
  | "build"
  | "cms"
  | "analytics"
  | "auth"
  | "captcha"
  | "state"
  | "hosting"
  | "other";

export interface FrameworkFinding {
  name: string;
  category: FrameworkCategory;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  version?: string;
}

export interface Signature {
  name: string;
  category: FrameworkCategory;
  needles: string[];
  strong?: string[];
  version?: RegExp;
}

export const SIGNATURES: Signature[] = [
  {
    name: "React",
    category: "framework",
    needles: [
      "__react_devtools_global_hook__",
      "react-dom",
      "react.production.min",
      "data-reactroot",
      "react.element",
    ],
    strong: ["__react_devtools_global_hook__", "data-reactroot"],
    version: /react-dom@?([0-9]+\.[0-9]+\.[0-9]+)/i,
  },
  { name: "Preact", category: "framework", needles: ["preact"], strong: ["preact"] },
  {
    name: "Vue",
    category: "framework",
    needles: ["__vue__", "vue.runtime", "createapp(", "data-v-"],
    strong: ["__vue__", "vue.runtime"],
  },
  { name: "Nuxt", category: "framework", needles: ["__nuxt__", "/_nuxt/"], strong: ["__nuxt__"] },
  {
    name: "Next.js",
    category: "framework",
    needles: ["__next_data__", "/_next/static", "__next_f", "next/router"],
    strong: ["__next_data__", "/_next/static"],
  },
  {
    name: "Angular",
    category: "framework",
    needles: ["ng-version", "platformbrowserdynamic", "@angular/core", "\u0275\u0275"],
    strong: ["ng-version", "platformbrowserdynamic"],
    version: /ng-version="([0-9]+\.[0-9]+\.[0-9]+[^"]*)"/i,
  },
  {
    name: "Svelte",
    category: "framework",
    needles: ["__svelte", "sveltecomponent", "svelte-"],
    strong: ["__svelte"],
  },
  {
    name: "SvelteKit",
    category: "framework",
    needles: ["__sveltekit", "/_app/immutable"],
    strong: ["__sveltekit"],
  },
  { name: "Solid", category: "framework", needles: ["solid-js", "createsignal"], strong: ["solid-js"] },
  { name: "Astro", category: "framework", needles: ["astro-island", "/_astro/"], strong: ["astro-island"] },
  { name: "Remix", category: "framework", needles: ["__remixcontext"], strong: ["__remixcontext"] },
  {
    name: "Gatsby",
    category: "framework",
    needles: ["___gatsby", "/page-data/"],
    strong: ["___gatsby"],
  },
  { name: "Ember", category: "framework", needles: ["ember.application", "ember.debug"], strong: ["ember.application"] },
  { name: "jQuery", category: "other", needles: ["jquery", "jquery.fn"], strong: ["jquery.fn"] },
  { name: "Alpine.js", category: "framework", needles: ["x-data", "alpine.start"], strong: ["alpine.start"] },
  { name: "htmx", category: "framework", needles: ["hx-get", "htmx"], strong: ["hx-get"] },
  { name: "Backbone", category: "framework", needles: ["backbone.model"], strong: ["backbone.model"] },
  { name: "Redux", category: "state", needles: ["__redux_devtools_extension__", "redux"], strong: ["__redux_devtools_extension__"] },
  { name: "Zustand", category: "state", needles: ["zustand"], strong: ["zustand"] },
  { name: "Pinia", category: "state", needles: ["pinia"], strong: ["pinia"] },
  { name: "Vite", category: "build", needles: ["/@vite/", "vite/modulepreload-polyfill", "__vite__"], strong: ["/@vite/", "__vite__"] },
  { name: "Webpack", category: "build", needles: ["webpackchunk", "__webpack_require__"], strong: ["webpackchunk"] },
  { name: "Parcel", category: "build", needles: ["parcelrequire"], strong: ["parcelrequire"] },
  { name: "Turbopack", category: "build", needles: ["turbopack"], strong: ["turbopack"] },
  { name: "WordPress", category: "cms", needles: ["wp-content", "wp-includes", "wp-json"], strong: ["wp-content", "wp-json"] },
  { name: "Shopify", category: "cms", needles: ["cdn.shopify.com", "myshopify.com", "shopifycdn.com"], strong: ["cdn.shopify.com", "myshopify.com"] },
  { name: "Magento", category: "cms", needles: ["magento_", "mage/cookies", "/static/version"], strong: ["magento_"] },
  { name: "Drupal", category: "cms", needles: ["drupalsettings", "/sites/default/files"], strong: ["drupalsettings"] },
  { name: "Ghost", category: "cms", needles: ["ghost-url", "/ghost/api/"], strong: ["ghost-url"] },
  { name: "Webflow", category: "other", needles: ["assets.website-files.com", "webflow.io", "uploads-ssl.webflow.com"], strong: ["assets.website-files.com", "webflow.io"] },
  { name: "Wix", category: "other", needles: ["wixstatic.com", "parastorage.com"], strong: ["wixstatic.com"] },
  { name: "Squarespace", category: "other", needles: ["static1.squarespace.com", "squarespace-cdn.com"], strong: ["static1.squarespace.com"] },
  { name: "Google Analytics", category: "analytics", needles: ["googletagmanager.com/gtag", "gtag(", "google-analytics.com"], strong: ["googletagmanager.com/gtag"] },
  { name: "Google Tag Manager", category: "analytics", needles: ["googletagmanager.com/gtm", "dataLayer"], strong: ["googletagmanager.com/gtm"] },
  { name: "Segment", category: "analytics", needles: ["cdn.segment.com", "analytics.load("], strong: ["cdn.segment.com"] },
  { name: "Mixpanel", category: "analytics", needles: ["mixpanel"], strong: ["mixpanel"] },
  { name: "Amplitude", category: "analytics", needles: ["amplitude"], strong: ["amplitude"] },
  { name: "PostHog", category: "analytics", needles: ["posthog"], strong: ["posthog"] },
  { name: "Sentry", category: "analytics", needles: ["sentry.init", "sentry.io", "@sentry/"], strong: ["sentry.init"] },
  { name: "Datadog RUM", category: "analytics", needles: ["datadog-rum", "dd_rum"], strong: ["datadog-rum"] },
  { name: "Hotjar", category: "analytics", needles: ["hotjar"], strong: ["hotjar"] },
  { name: "FullStory", category: "analytics", needles: ["fullstory"], strong: ["fullstory"] },
  { name: "Stripe.js", category: "other", needles: ["js.stripe.com", "stripe("], strong: ["js.stripe.com"] },
  { name: "Firebase", category: "other", needles: ["firebaseio.com", "firebaseapp.com", "firebase."], strong: ["firebaseio.com"] },
  { name: "Supabase", category: "other", needles: ["supabase.co"], strong: ["supabase.co"] },
  { name: "Auth0", category: "auth", needles: ["auth0"], strong: ["auth0"] },
  { name: "Clerk", category: "auth", needles: ["clerk."], strong: ["clerk."] },
  { name: "LaunchDarkly", category: "other", needles: ["launchdarkly"], strong: ["launchdarkly"] },
  { name: "Unleash", category: "other", needles: ["unleash"], strong: ["unleash"] },
  { name: "GrowthBook", category: "other", needles: ["growthbook"], strong: ["growthbook"] },
  { name: "Optimizely", category: "other", needles: ["optimizely"], strong: ["optimizely"] },
  { name: "reCAPTCHA", category: "captcha", needles: ["recaptcha", "grecaptcha"], strong: ["grecaptcha"] },
  { name: "hCaptcha", category: "captcha", needles: ["hcaptcha"], strong: ["hcaptcha"] },
  { name: "Cloudflare Turnstile", category: "captcha", needles: ["challenges.cloudflare.com"], strong: ["challenges.cloudflare.com"] },
  { name: "Cloudflare", category: "hosting", needles: ["cdnjs.cloudflare.com", "__cf_bm"], strong: ["cdnjs.cloudflare.com"] },
  { name: "Intercom", category: "other", needles: ["intercom"], strong: ["intercom"] },
  { name: "Algolia", category: "other", needles: ["algolia"], strong: ["algolia"] },
];

export interface FrameworkInput {
  html: string;
  scripts: string[];
  urls?: string[];
}

/** Detects frameworks/CMS/analytics from HTML text, scripts and asset URLs. */
export function detectFrameworks(input: FrameworkInput): FrameworkFinding[] {
  const hay = [input.html, ...input.scripts, ...(input.urls ?? [])]
    .join("\n")
    .toLowerCase();

  const out: FrameworkFinding[] = [];
  for (const sig of SIGNATURES) {
    const hits = sig.needles.filter((n) => hay.includes(n.toLowerCase()));
    if (hits.length === 0) continue;

    const strongHit = (sig.strong ?? []).some((n) => hay.includes(n.toLowerCase()));
    const confidence: FrameworkFinding["confidence"] =
      strongHit || hits.length >= 2 ? "high" : "medium";

    const finding: FrameworkFinding = {
      name: sig.name,
      category: sig.category,
      confidence,
      evidence: hits.slice(0, 3),
    };

    if (sig.version) {
      const m = sig.version.exec(hay);
      if (m?.[1]) finding.version = m[1];
    }
    out.push(finding);
  }

  return out;
}
