import { onCall, HttpsError } from "firebase-functions/v2/https";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { getMitgliedsantragHtml } from "../utils/html";
import type { MitgliedsantragData } from "../types/mitgliederAntrag";

export const mitgliedsAntragEmail = onCall(
  {
    region: "europe-west3",
    memory: "512MiB",
    secrets: ["ANTRAG_EMAIL", "ANTRAG_PASSWORT", "SMTP_SERVER", "SMTP_PORT"],
  },
  async (request) => {
    const payload = request.data as { mitgliedsAntragData: MitgliedsantragData };
    if (!payload?.mitgliedsAntragData) {
      throw new HttpsError("invalid-argument", "Fehlende Felder (mitgliedsAntragData).");
    }

    const data = payload.mitgliedsAntragData;
    if (!data.email?.trim()) {
      throw new HttpsError("invalid-argument", "E-Mail-Adresse fehlt.");
    }

    const mailUser = process.env.ANTRAG_EMAIL!;
    const mailPass = process.env.ANTRAG_PASSWORT!;
    const smtpHost = process.env.SMTP_SERVER!;
    const smtpPort = Number(process.env.SMTP_PORT ?? "587");

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: mailUser, pass: mailPass },
    } as SMTPTransport.Options);

    const subject = "Bestätigung Ihres Mitgliedsantrags beim MTV Geismar";
    const html = getMitgliedsantragHtml(data);

    const info = await transporter.sendMail({
      from: `"MTV Geismar" <${mailUser}>`,
      to: data.email.trim(),
      subject,
      html,
    });

    return {
      success: true,
      messageId: info.messageId,
      info: "Eine E-Mail wurde an " + data.email + " gesendet.",
    };
  }
);
