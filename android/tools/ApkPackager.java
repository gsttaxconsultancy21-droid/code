import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;
import com.reandroid.apk.APKLogger;
import com.reandroid.apk.ApkModule;
import com.reandroid.apk.ApkModuleXmlEncoder;
import com.reandroid.arsc.chunk.xml.AndroidManifestBlock;

import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Collections;

/**
 * Encodes a staged module directory (XML manifest + res + root files) into an
 * APK with ARSCLib, then signs it (APK Signature Scheme v2; minSdk 24) with apksig.
 *
 * Usage: ApkPackager <moduleDir> <unsigned.apk> <signed.apk> <keystore.p12> <storePass> <alias>
 */
public class ApkPackager {
    public static void main(String[] args) throws Exception {
        File moduleDir = new File(args[0]);
        File unsigned = new File(args[1]);
        File signed = new File(args[2]);

        ApkModuleXmlEncoder encoder = new ApkModuleXmlEncoder();
        encoder.setApkLogger(new APKLogger() {
            public void logMessage(String msg) { System.out.println("  " + msg); }
            public void logError(String msg, Throwable tr) { System.err.println("  ERROR " + msg); if (tr != null) tr.printStackTrace(); }
            public void logVerbose(String msg) { }
        });
        encoder.scanDirectory(moduleDir);
        ApkModule module = encoder.getApkModule();
        module.writeApk(unsigned);

        char[] pass = args[4].toCharArray();
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (FileInputStream in = new FileInputStream(args[3])) {
            ks.load(in, pass);
        }
        PrivateKey key = (PrivateKey) ks.getKey(args[5], pass);
        X509Certificate cert = (X509Certificate) ks.getCertificate(args[5]);
        ApkSigner.SignerConfig signer = new ApkSigner.SignerConfig.Builder(
                "INKLAND", key, Collections.singletonList(cert)).build();
        new ApkSigner.Builder(Collections.singletonList(signer))
                .setInputApk(unsigned)
                .setOutputApk(signed)
                .setMinSdkVersion(24)
                .setV1SigningEnabled(false)
                .setV2SigningEnabled(true)
                .setCreatedBy("Inkland build")
                .build()
                .sign();

        ApkVerifier.Result result = new ApkVerifier.Builder(signed).build().verify();
        for (Object issue : result.getErrors()) System.err.println("  verify error: " + issue);
        if (!result.isVerified() || !result.isVerifiedUsingV2Scheme()) {
            throw new IllegalStateException("Signature verification failed");
        }

        AndroidManifestBlock manifest = module.getAndroidManifest();
        System.out.println("Package:  " + manifest.getPackageName() + " " + manifest.getVersionName()
                + " (" + manifest.getVersionCode() + "), sdk " + manifest.getMinSdkVersion()
                + "-" + manifest.getTargetSdkVersion());
        System.out.println("Activity: " + manifest.getMainActivityClassName());
        System.out.println("Signed and verified (v2): " + signed);
    }
}
