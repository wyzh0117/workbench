/**
 * Constants shared by the shell (`main.js`) and the view layer (`views.js`).
 *
 * They live in their own module so the view layer never has to import the
 * shell: a `main.js` ⇄ `views.js` cycle would instantiate the whole application
 * twice whenever the shell is loaded under a second specifier (tests import it
 * with a cache-busting query), and each instance would boot its own store,
 * listeners and autosave timers.
 */

/**
 * Hidden browser file input used when no native shell is present.  Kept in one
 * place so the native picker, drag & drop and MIME mapping stay a single
 * implementation.
 */
export const PROJECT_FILE_PICKER =
  `<input hidden type="file" data-project-file accept=".json,.md,.markdown,.txt,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.webm,.mov,.m4v,.mp3,.wav,.m4a,.aac,.ogg,.pdf,.doc,.docx,.zip" />`;
