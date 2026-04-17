# CDK jars

Drop `nmrshiftdb2.jar` (and any additional CDK dependency jars) into this
directory. The backend picks up every `*.jar` here automatically — no
`CDK_JAR_PATH` env var needed.

## Automatic CDK bundle

Run:

```
python backend/scripts/fetch_cdk.py
```

That pulls `cdk-bundle-2.9.jar` from Maven Central into this folder. It's a
one-time download (~35 MB) and gives the engine the Chemistry Development
Kit classes.

## nmrshiftdb2 predictor

The HOSE-code shift tables live in `nmrshiftdb2.jar`, which is **not** on
Maven Central. Download the latest release from
<https://sourceforge.net/projects/nmrshiftdb2/> and drop the jar into this
folder alongside the CDK bundle. The engine scans the directory on startup
and adds every jar to the JVM classpath.

Restart the backend afterwards (`run-nmr.bat backend`). `/engines` will
report `cdk` as ready once the jars are in place.
