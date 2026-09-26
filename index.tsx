/// <reference path="../.stewrd/plugin-api.d.ts" />
import type { PluginContext, PluginApi } from "stewrd-plugin-api";

export function activate(ctx: PluginContext) {
  ctx.api.log.info("stewrd-terminal plugin activated");
  ctx.api.statusIcon.set("idle");
}

export function deactivate() {}

export function Component({ api }: { api: PluginApi }) {
  return (
    <div>
      <h2>Stewrd Terminal</h2>
    </div>
  );
}
