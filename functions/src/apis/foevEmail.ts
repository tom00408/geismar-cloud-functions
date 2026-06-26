import { onCall, HttpsError } from "firebase-functions/v2/https";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { getFoevHtml } from "../utils/html";
import type { FoevData } from "../types/foev";

export const foevEmail = onCall(
  {
    region: "europe-west3",
    memory: "512MiB",
    secrets: ["ANTRAG_EMAIL", "ANTRAG_PASSWORT", "SMTP_SERVER", "SMTP_PORT"],
  },
  async (request) => {

    const data = request.data as { foevData: FoevData };
    if (!data?.foevData) {
      throw new HttpsError("invalid-argument", "Fehlende Felder (foevData).");
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

    const subject ="Bestätigung ihres Mitgliedsantrags beim Förderverein des MTV Geismar";
    const html = getFoevHtml(data.foevData);

    const info = await transporter.sendMail({
      from: `"Förderverein des MTV Geismar" <${mailUser}>`,
      to: data.foevData.email,
      subject,
      html,
    });

   

    // Bei callable immer ein JSON-serialisierbares Objekt zurückgeben
    return { success: true, messageId: info.messageId, info: "Eine Email wurde an " + data.foevData.email + " gesendet." };
  }
);
