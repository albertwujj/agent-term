# What a printed name opens

Click a file name or path where the agent prints it, and the terminal finds the file and opens it: markdown, reviews, images, video, and PDFs in the viewer above the prompt, code references in your IDE, everything else through the OS ([what a click does](clicks.md)). This page is how the name becomes a file.

**Any form works.** A bare file name (`README.md`), a relative path (`docs/plan.md`, `../agent-lock/README.md`), an absolute path, or one starting with `~`. So the agent's ordinary output is enough; it does not have to print full paths.

**Where it looks.** An absolute or `~` path names one file and opens if it exists. A relative path is tried under the session's shell directory first. When that misses, the terminal searches for a path that ends the same way: through the repo, then its neighbouring folders for markdown, then your home folder. A bare name is searched the same way, by name.

**Several matches.** A bare name like `README.md` often exists in more than one place. One match opens at once. Several show a chooser listing them, the one under the session's directory first; pick one or dismiss it. Hold Alt (Option on a Mac) while clicking to see every match everywhere, even when one sits right under the session's directory; that is how you reach a same-named file in another repo.

**What is skipped.** Dependency and cache folders (`node_modules`, `.cache`, `.npm`, `Library`) and the contents of `.git`, except `.git/discussion`, where discussion docs live by convention. A search stops after a few seconds and offers what it has found by then.

**When nothing matches**, a brief notice says the name could not be located, and nothing opens.

**Without a click.** `Ctrl/Cmd+Shift+U` opens the viewer selector. Type part of a name and it lists matching files from the repo, its neighbours, and home, newest first ([open a viewer](viewer.md)).

On Windows the paths are WSL paths, and the search runs inside your distro.
