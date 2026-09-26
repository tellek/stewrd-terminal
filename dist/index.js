// ../../stewrd-terminal/index.tsx
import { jsx } from "react/jsx-runtime";
function activate(ctx) {
  ctx.api.log.info("stewrd-terminal plugin activated");
  ctx.api.statusIcon.set("idle");
}
function deactivate() {
}
function Component({ api }) {
  return /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx("h2", { children: "Stewrd Terminal" }) });
}
export {
  Component,
  activate,
  deactivate
};
//# sourceMappingURL=index.js.map
