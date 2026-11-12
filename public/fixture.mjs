import { browserReporter } from "/reporter.mjs";
browserReporter({
  routes: [{ id: "landing" }, { id: "library" }, { id: "studio" }],
  enabled: true,
  policy: "synthetic",
});
