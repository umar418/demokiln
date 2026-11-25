# Security policy

## Reporting a problem

Please report security problems privately, not in a public issue.

Use GitHub's private reporting: on the repository, open the **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Include what you can of:

- what you did (a steps file, script or page that shows the problem),
- what happened, and what you expected,
- the Demokiln version (`demokiln --version`), your operating system and Node version.

You should get a first reply within a week. Please allow time for a fix before sharing details publicly.

## What counts

Demokiln treats the app it captures, steps files, baselines and recorded pages as untrusted. Reports are especially welcome for:

- anything from a captured page running in, or loading from the network in, a finished demo;
- masked text, password or card field values, or credentials ending up in an output file;
- the build, `check`, `export` or `preview` reading or writing files outside the folders they were given;
- the build being made to contact machines other than the app it was pointed at;
- a steps file or recorded page causing commands to run or environment variables to leak.

## Supported versions

Only the latest version receives fixes.

## Known limits

These are documented in the README and are not treated as vulnerabilities: text inside images is not scanned for credentials; a page you record can read what you type into it; a value typed by a `fill` step appears on the next screen.
