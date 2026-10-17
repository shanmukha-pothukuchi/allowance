import chalk from "chalk";

const QUIET = process.env.DEMO_FAST === "1";

export const pace = (ms: number) => new Promise<void>((r) => setTimeout(r, QUIET ? Math.min(ms, 50) : ms));

export function act(n: number, title: string, subtitle: string) {
  console.log("");
  console.log(chalk.bold.bgWhite.black(`  ACT ${n}  `) + " " + chalk.bold.white(title));
  console.log(chalk.dim(`         ${subtitle}`));
  console.log("");
}

export function agentLine(name: string, msg: string, color: (s: string) => string = chalk.cyan) {
  console.log(`  ${color(name.padEnd(14))} ${msg}`);
}

export const ok = (s: string) => chalk.green(s);
export const bad = (s: string) => chalk.red(s);
export const warn = (s: string) => chalk.yellow(s);
export const dim = (s: string) => chalk.dim(s);
export const money = (s: string) => chalk.bold.green(`$${s.replace(/^\$/, "")}`);

export function receiptLine(r: { amount: string; description: string; txHash?: string; explorerUrl?: string; kind: string }) {
  const verb = r.kind === "earn" ? "Earned" : r.kind === "topup" ? "Added" : "Paid";
  const hash = r.txHash ? ` ${dim("tx " + r.txHash.slice(0, 10) + "…")}` : "";
  const link = r.explorerUrl ? ` ${dim(r.explorerUrl)}` : "";
  return `${verb} ${money(r.amount)} ${r.kind === "earn" ? "for" : "to"} ${r.description}.${hash}${link}`;
}

export function banner(text: string) {
  const line = "─".repeat(Math.max(20, text.length + 4));
  console.log(chalk.bold.magenta(line));
  console.log(chalk.bold.magenta(`  ${text}`));
  console.log(chalk.bold.magenta(line));
}
