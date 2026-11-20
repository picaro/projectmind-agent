import { main } from "./cli.ts";

main(process.argv.slice(2), process.env).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
