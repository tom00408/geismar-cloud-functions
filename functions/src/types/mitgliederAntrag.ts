/** Daten vom Verein-Mitgliedsantrag-Formular (für Bestätigungs-E-Mail) */
export interface MitgliedsantragData {
  anrede?: string;
  vorname: string;
  nachname: string;
  email: string;
  telefon?: string;
  strasse?: string;
  plz?: string;
  ort?: string;
  land?: string;
  geburtsdatum?: string;
  abteilung?: string;
  beginn?: string;
  datum?: string;
  zahlungsweise?: string;
  iban?: string;
  kreditinstitut?: string;
  [key: string]: string | undefined;
}
