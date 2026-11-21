{{- define "kestrel-it.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kestrel-it.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "kestrel-it.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kestrel-it.labels" -}}
helm.sh/chart: {{ include "kestrel-it.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kestrel-it
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "kestrel-it.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kestrel-it.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "kestrel-it.secretName" -}}
{{- if .Values.config.existingSecret -}}
{{- .Values.config.existingSecret -}}
{{- else -}}
{{- printf "%s-secret" (include "kestrel-it.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "kestrel-it.databaseUrl" -}}
{{- if .Values.config.secrets.externalDatabaseUrl -}}
{{- .Values.config.secrets.externalDatabaseUrl -}}
{{- else if .Values.postgresql.enabled -}}
{{- printf "postgresql://%s:%s@%s-postgresql:%d/%s" .Values.postgresql.auth.username .Values.postgresql.auth.password (include "kestrel-it.fullname" .) (int .Values.postgresql.service.port) .Values.postgresql.auth.database -}}
{{- else -}}
{{- "postgresql://kestrel:kestrel@localhost:5432/kestrel_it" -}}
{{- end -}}
{{- end -}}
