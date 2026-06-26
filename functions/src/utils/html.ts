import type { FoevData } from "../types/foev";
import type { MitgliedsantragData } from "../types/mitgliederAntrag";

export function getMitgliedsantragHtml(d: MitgliedsantragData): string {
  const name = [d.anrede, d.vorname, d.nachname].filter(Boolean).join(" ") || `${d.vorname} ${d.nachname}`;
  return `
<p>Hallo ${name},</p>
<p>vielen Dank für Ihren Mitgliedsantrag beim MTV Geismar.</p>
<p>Ihr Mitgliedsantrag wurde erfolgreich erstellt.</p>
<p>Mit freundlichen Grüßen,<br>Ihr MTV Geismar Team</p>

<h2>Ihre Angaben</h2>
<p>Anrede: ${d.anrede ?? "—"}</p>
<p>Vorname: ${d.vorname ?? "—"}</p>
<p>Nachname: ${d.nachname ?? "—"}</p>
<p>E-Mail: ${d.email ?? "—"}</p>
<p>Telefon: ${d.telefon ?? "—"}</p>
<p>Straße: ${d.strasse ?? "—"}</p>
<p>PLZ: ${d.plz ?? "—"}</p>
<p>Ort: ${d.ort ?? "—"}</p>
<p>Land: ${d.land ?? "—"}</p>
<p>Geburtsdatum: ${d.geburtsdatum ?? "—"}</p>
<p>Abteilung: ${d.abteilung ?? "—"}</p>
<p>Beginn der Mitgliedschaft: ${d.beginn ?? "—"}</p>
<p>Datum des Antrags: ${d.datum ?? "—"}</p>
<p>Zahlungsweise: ${d.zahlungsweise ?? "—"}</p>
`;
}

export function getFoevHtml(foevData: FoevData){

    const betragZusatzEinmalig = foevData.betragZusatzEinmalig ? `${foevData.betragZusatzEinmalig}€` : "";
    const betragZusatzJaehrlich = foevData.betragZusatzJaehrlich ? `${foevData.betragZusatzJaehrlich}€` : "";


    return `
    <p>Hallo ${foevData.vorname} ${foevData.nachname},</p>
    <p>vielen Dank für Ihren Mitgliedsantrag beim Förderverein des MTV Geismar.</p>
    <p>Ihr Mitgliedsantrag wurde erfolgreich erstellt.</p>

    ${betragZusatzEinmalig ? `<p>Sie spenden einen zusätzlichen einmaligen Betrag von ${betragZusatzEinmalig}.</p>` : ""}
    ${betragZusatzJaehrlich ? `<p>${betragZusatzEinmalig ? "Und " : ""}Sie spenden einen zusätzlichen jährlichen Betrag von ${betragZusatzJaehrlich}.</p>` : ""}

    <p>Mit freundlichen Grüßen,<br>Ihr MTV Geismar Team</p>

    <h2>Ihre Angaben</h2>
    <p>Vorname: ${foevData.vorname}</p>
    <p>Nachname: ${foevData.nachname}</p>
    <p>Telefon: ${foevData.telefon}</p>
    <p>Email: ${foevData.email}</p>
    <p>Geburtstag: ${foevData.geburtstag}</p>
    <p>Beginn der Mitgliedschaft: ${foevData.beginn}</p>
    <p>IBAN: ${foevData.iban}</p>
    <p>BIG: ${foevData.big}</p>
    <p>Bank: ${foevData.bank}</p>
    <p>Kontoinhaber: ${foevData.kontoinhaber}</p>
    <p>Strasse: ${foevData.strasse}</p>
    <p>PLZ: ${foevData.plz}</p>
    <p>Ort: ${foevData.ort}</p>
    <p>Land: ${foevData.land}</p>
    `; 
}