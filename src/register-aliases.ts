// Compiled builds resolve @config/@shared/@utils through module-alias to
// dist/. Under ts-node, tsconfig-paths already maps them to src/*.ts —
// letting module-alias also register would split every aliased module
// into a second identity (src vs dist), and with it every tsyringe
// singleton. Register only when running compiled output.
if (__filename.endsWith(".js")) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("module-alias/register");
}
