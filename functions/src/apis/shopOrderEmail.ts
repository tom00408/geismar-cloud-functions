import { onCall, HttpsError } from 'firebase-functions/v2/https';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

export const shopOrderEmail = onCall(
	{
		region: 'europe-west3',
		memory: '512MiB',
		secrets: ['USER_EMAIL', 'USER_PASSWORT', 'SMTP_SERVER', 'SMTP_PORT'],
	},
	async (request) => {
		const data = request.data as {
			to: string;
			name: string;
			filename: string;
			pdfBase64: string;
		};
		if (!data?.to || !data?.name || !data?.filename || !data?.pdfBase64) {
			throw new HttpsError(
				'invalid-argument',
				'Fehlende Felder (to, name, filename, pdfBase64).'
			);
		}

		const base64 = data.pdfBase64.includes(',')
			? data.pdfBase64.split(',')[1]
			: data.pdfBase64;

		if (base64.length > 8 * 1024 * 1024) {
			throw new HttpsError(
				'invalid-argument',
				'PDF zu groß (Base64 > 8 MB).'
			);
			return;
		}

		const mailUser = process.env.USER_EMAIL!;
		const mailPass = process.env.USER_PASSWORT!;
		const smtpHost = process.env.SMTP_SERVER!;
		const smtpPort = Number(process.env.SMTP_PORT ?? '587');

		const transporter = nodemailer.createTransport({
			host: smtpHost,
			port: smtpPort,
			secure: smtpPort === 465,
			auth: { user: mailUser, pass: mailPass },
		} as SMTPTransport.Options);

		const pdfBuffer = Buffer.from(base64, 'base64');

		const subject = `Ihre Bestellung vom MTV Geismar Shop`;

		const html = `
      <p>Hallo ${data.name},</p>
      <p>vielen Dank für Ihre Bestellung im MTV Geismar Shop!</p>
      <p>Im Anhang finden Sie Ihre Rechnung als PDF.</p>
      <p>Mit freundlichen Grüßen,<br>Ihr MTV Geismar Team</p>
    `;

		const info = await transporter.sendMail({
			from: `"MTV Geismar Shop" <${mailUser}>`,
			to: data.to,
			subject,
			html: html,
			attachments: [
				{
					filename: data.filename.endsWith('.pdf')
						? data.filename
						: `${data.filename}.pdf`,
					content: pdfBuffer,
					contentType: 'application/pdf',
				},
			],
		});

		return {
			success: true,
			messageId: info.messageId,
			info: 'Eine Email wurde an ' + data.to + ' gesendet.',
		};
	}
);
