import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Repository-local root that owns every acceptance write/delete. */
export const DEFAULT_ARTIFACT_DIR = 'test-results/acceptance';

/**
 * Resolve the acceptance artifact directory and reject anything that escapes
 * the dedicated repository-local artifact root. This runs before the runner
 * creates or removes any file, so an inherited/absolute/traversal override can
 * never redirect recursive cleanup outside the checkout.
 */
export function resolveArtifactDir(root, requested = DEFAULT_ARTIFACT_DIR) {
  const artifactRoot = resolve(root, DEFAULT_ARTIFACT_DIR);
  const value =
    typeof requested === 'string' && requested.trim() !== ''
      ? requested.trim()
      : DEFAULT_ARTIFACT_DIR;
  const candidate = resolve(root, value);
  const inside = relative(artifactRoot, candidate);
  if (inside !== '' && (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))) {
    throw new Error(
      `acceptance artifact directory must stay inside ${artifactRoot}; refusing "${value}"`,
    );
  }
  // Lexical containment alone is insufficient when an existing parent is a
  // symlink: deleting candidate/playwright would follow that parent outside.
  let ancestor = resolve(root);
  for (const segment of relative(ancestor, candidate).split(sep)) {
    ancestor = join(ancestor, segment);
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        throw new Error(`acceptance artifact path must not contain a symbolic link: ${ancestor}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return candidate;
}
