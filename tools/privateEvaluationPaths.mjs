import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const privateEvaluationRoot = path.resolve(
  process.env.MAZZY_PRIVATE_EVAL_DIR ??
    path.join(homedir(), "Library", "Application Support", "Mazzy", "private-evaluation")
);

export const ensurePrivateDirectory = async (directory = privateEvaluationRoot) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
};
