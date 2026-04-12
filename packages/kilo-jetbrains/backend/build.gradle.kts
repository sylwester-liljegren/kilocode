import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations
import javax.inject.Inject

plugins {
    alias(libs.plugins.rpc)
    alias(libs.plugins.kotlin)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.openapi.generator)
}

/**
 * Resolve the absolute path to `bun`. The Gradle daemon's PATH is often
 * stripped down and doesn't include Homebrew or user-local bin dirs.
 * Probe common install locations so the build works without manual PATH setup.
 */
fun findBun(): String {
    // 1. Already on PATH?
    val which = runCatching {
        ProcessBuilder("which", "bun")
            .redirectErrorStream(true)
            .start()
            .inputStream.bufferedReader().readLine()?.trim()
    }.getOrNull()
    if (which != null && File(which).isFile) return which

    // 2. Common install locations
    val home = System.getProperty("user.home")
    val candidates = listOf(
        "$home/.bun/bin/bun",
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/bun",
        "$home/.nvm/current/bin/bun",
    )
    for (path in candidates) {
        val f = File(path)
        if (f.isFile && f.canExecute()) return f.absolutePath
    }

    // 3. Fall back — let the OS resolve it (will fail with a clear message)
    return "bun"
}

abstract class PrepareLocalCliTask : DefaultTask() {
    @get:InputFile
    abstract val script: RegularFileProperty

    @get:Internal
    abstract val root: DirectoryProperty

    @get:OutputDirectory
    abstract val out: DirectoryProperty

    @get:Input
    abstract val platform: Property<String>

    @get:Input
    abstract val exe: Property<String>

    @get:Inject
    abstract val exec: ExecOperations

    @TaskAction
    fun run() {
        val bin = out.file("${platform.get()}/${exe.get()}").get().asFile
        if (bin.exists()) return
        exec.exec {
            workingDir = root.get().asFile
            commandLine(findBun(), "script/build.ts", "--prepare-cli")
        }
    }
}

kotlin {
    jvmToolchain(21)
}

val generatedApi = layout.buildDirectory.dir("generated/openapi/src/main/kotlin")

sourceSets {
    main {
        resources.srcDir(layout.buildDirectory.dir("generated/cli"))
        kotlin.srcDir(generatedApi)
    }
}

openApiGenerate {
    generatorName.set("kotlin")
    library.set("jvm-okhttp4")
    inputSpec.set("${rootDir}/../sdk/openapi.json")
    outputDir.set(layout.buildDirectory.dir("generated/openapi").get().asFile.absolutePath)
    packageName.set("ai.kilocode.jetbrains.api")
    apiPackage.set("ai.kilocode.jetbrains.api.client")
    modelPackage.set("ai.kilocode.jetbrains.api.model")
    configOptions.set(mapOf(
        "serializationLibrary" to "moshi",
        "omitGradleWrapper" to "true",
        "omitGradlePluginVersions" to "true",
        "useCoroutines" to "false",
        "sourceFolder" to "src/main/kotlin",
        "enumPropertyNaming" to "UPPERCASE",
    ))
    // Remap schema "File" so the generated class is not named java.io.File
    modelNameMappings.set(mapOf(
        "File" to "DiffFileInfo",
    ))
    // Map empty anyOf references to kotlin.Any
    typeMappings.set(mapOf(
        "AnyOfLessThanGreaterThan" to "kotlin.Any",
        "anyOf<>" to "kotlin.Any",
    ))
    // Normalise OpenAPI 3.1 → 3.0-compatible patterns
    openapiNormalizer.set(mapOf(
        "SIMPLIFY_ANYOF_STRING_AND_ENUM_STRING" to "true",
        "SIMPLIFY_ONEOF_ANYOF" to "true",
    ))
    generateApiTests.set(false)
    generateModelTests.set(false)
    generateApiDocumentation.set(false)
    generateModelDocumentation.set(false)
}

// Fix openapi-generator 3.1.1 codegen bugs in generated Kotlin sources.
//
// 1) Boolean const enum fix:
//    The OpenAPI spec uses `const: true` on boolean fields (e.g. `healthy`).
//    openapi-generator turns these into single-value enum classes:
//      val healthy: GlobalHealth200Response.Healthy
//      enum class Healthy(val value: kotlin.Boolean) { @Json(name = "true") TRUE("true") }
//    Moshi's EnumJsonAdapter calls nextString() for the value, but the server sends
//    a JSON boolean `true`, not a JSON string `"true"`.
//    Fix: replace the enum field type with kotlin.Boolean, remove the enum class.
//
// 2) anyOf[string, null] fix:
//    Fields like Config.model defined as `anyOf: [{type: string}, {type: null}]`
//    get generated as empty wrapper classes (e.g. ConfigModel). Moshi then expects
//    a JSON object but the server sends a plain string.
//    Fix: replace the field type with kotlin.String?, delete the empty wrapper class file.
val fixGeneratedApi by tasks.registering {
    dependsOn("openApiGenerate")
    val dir = generatedApi
    doLast {
        // ── Fix 1: boolean const enums ──────────────────────────────

        val enumDecl = Regex(
            """enum class (\w+)\(val value: kotlin\.Boolean\)"""
        )
        dir.get().asFile.walkTopDown().filter { it.extension == "kt" }.forEach { file ->
            var text = file.readText()
            val names = enumDecl.findAll(text).map { it.groupValues[1] }.toList()
            if (names.isEmpty()) return@forEach

            for (name in names) {
                // Replace field type: `val foo: EnclosingClass.EnumName` → `val foo: kotlin.Boolean`
                text = text.replace(Regex("""(val \w+:\s*)\w+\.$name""")) { m ->
                    "${m.groupValues[1]}kotlin.Boolean"
                }
                // Remove the @JsonClass annotation + enum class block
                text = text.replace(Regex(
                    """\n\s*@JsonClass\(generateAdapter = false\)\s*\n\s*enum class $name\(val value: kotlin\.Boolean\)\s*\{[^}]*\}"""
                ), "")
                // Remove the orphaned KDoc block that preceded the enum (lines of ` *` ending with `*/`)
                text = text.replace(Regex(
                    """\n\s*/\*\*\s*\n(\s*\*[^\n]*\n)*\s*\*/\s*(?=\n\s*\n)"""
                ), "")
            }
            file.writeText(text)
        }

        // ── Fix 2: anyOf[string, null] empty wrapper classes ────────
        //
        // These are classes generated from `anyOf: [{type: string}, {type: null}]`
        // that should be kotlin.String? instead. The generated class is an empty
        // `class FooBar () {}` and fields referencing it need to become String?.
        val emptyWrappers = listOf("ConfigModel", "ConfigSmallModel")
        for (wrapper in emptyWrappers) {
            // Delete the empty wrapper class file
            val wrapperFile = dir.get().file(
                "ai/kilocode/jetbrains/api/model/$wrapper.kt"
            ).asFile
            if (wrapperFile.exists()) {
                wrapperFile.delete()
            }

            // Replace all field references in other files:
            //   `val model: ConfigModel? = null` → `val model: kotlin.String? = null`
            dir.get().asFile.walkTopDown().filter { it.extension == "kt" }.forEach { file ->
                val text = file.readText()
                if (!text.contains(wrapper)) return@forEach
                var patched = text
                // Replace field type references
                patched = patched.replace(Regex(""":\s*$wrapper\?"""), ": kotlin.String?")
                patched = patched.replace(Regex(""":\s*$wrapper([^?\w])"""), ": kotlin.String?$1")
                // Remove the import line
                patched = patched.replace(Regex("""import [^\n]*\.$wrapper\n"""), "")
                if (patched != text) {
                    file.writeText(patched)
                }
            }
        }
    }
}

tasks.named("compileKotlin") {
    dependsOn(fixGeneratedApi)
}

val cliDir = layout.buildDirectory.dir("generated/cli/cli")
val production = providers.gradleProperty("production").map { it.toBoolean() }.orElse(false)

val requiredPlatforms = listOf(
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "windows-x64",
    "windows-arm64",
)

val localCli by tasks.registering(PrepareLocalCliTask::class) {
    description = "Prepare local CLI binary for JetBrains dev"
    val os = providers.systemProperty("os.name").map {
        val name = it.lowercase()
        if (name.contains("mac")) return@map "darwin"
        if (name.contains("win")) return@map "windows"
        if (name.contains("linux")) return@map "linux"
        throw GradleException("Unsupported host OS: $it")
    }
    val arch = providers.systemProperty("os.arch").map {
        val name = it.lowercase()
        if (name == "aarch64" || name == "arm64") return@map "arm64"
        if (name == "x86_64" || name == "amd64") return@map "x64"
        throw GradleException("Unsupported host arch: $it")
    }
    script.set(rootProject.layout.projectDirectory.file("script/build.ts"))
    root.set(rootProject.layout.projectDirectory)
    out.set(cliDir)
    platform.set(os.zip(arch) { a, b -> "$a-$b" })
    exe.set(platform.map { if (it.startsWith("windows")) "kilo.exe" else "kilo" })
}

val checkCli by tasks.registering {
    description = "Verify CLI binaries exist before building"
    val dir = cliDir.map { it.asFile }
    val prod = production.get()
    val platforms = requiredPlatforms.toList()
    if (!prod) {
        dependsOn(localCli)
    }
    doLast {
        val resolved = dir.get()
        if (!resolved.exists() || resolved.listFiles()?.isEmpty() != false) {
            throw GradleException(
                "CLI binaries not found at ${resolved.absolutePath}.\n" +
                "Run 'bun run build' from packages/kilo-jetbrains/ to build CLI and plugin together."
            )
        }
        if (prod) {
            val missing = platforms.filter { platform ->
                val dir = File(resolved, platform)
                val exe = if (platform.startsWith("windows")) "kilo.exe" else "kilo"
                !File(dir, exe).exists()
            }
            if (missing.isNotEmpty()) {
                throw GradleException(
                    "Production build requires all platform CLI binaries.\n" +
                    "Missing: ${missing.joinToString(", ")}\n" +
                    "Run 'bun run build:production' to build all platforms."
                )
            }
        }
    }
}

tasks.processResources {
    dependsOn(checkCli)
}

dependencies {
    intellijPlatform {
        intellijIdea(libs.versions.intellij.platform)
        bundledModule("intellij.platform.kernel.backend")
        bundledModule("intellij.platform.rpc.backend")
        bundledModule("intellij.platform.backend")
    }

    implementation(project(":shared"))
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.moshi)
    implementation(libs.moshi.kotlin)
}
