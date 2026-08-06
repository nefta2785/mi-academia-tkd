from odoo import fields, models


class TaekwondoReporteGanancias(models.Model):
    _name = 'taekwondo.reporte_ganancias'
    _description = 'Reporte de división de ganancias'

    fecha_inicio = fields.Date(
        string='Fecha de inicio',
        required=True,
        default=lambda self: fields.Date.context_today(self).replace(day=1),
    )
    fecha_fin = fields.Date(
        string='Fecha de fin',
        required=True,
        default=fields.Date.context_today,
    )
    porcentaje_socio = fields.Float(string='Porcentaje del socio (%)', default=50.0)
    gasto_fijo_mensual = fields.Float(string='Gasto mensual fijo (Renta)', default=1200.0)
    ingresos_totales = fields.Float(readonly=True)
    gastos_totales = fields.Float(readonly=True)
    utilidad_neta = fields.Float(readonly=True)
    parte_socio = fields.Float(readonly=True)
    parte_propia = fields.Float(readonly=True)
    retiros_propio_total = fields.Float(readonly=True)
    retiros_socio_total = fields.Float(readonly=True)
    saldo_pendiente_propio = fields.Float(readonly=True)
    saldo_pendiente_socio = fields.Float(readonly=True)
    costos_operativos_examen = fields.Float(readonly=True)
    ganancia_torneos = fields.Float(readonly=True)

    def action_calcular(self):
        for reporte in self:
            facturas = self.env['account.move'].search([
                ('move_type', '=', 'out_invoice'),
                ('state', '=', 'posted'),
                ('invoice_date', '>=', reporte.fecha_inicio),
                ('invoice_date', '<=', reporte.fecha_fin),
            ])
            gastos = self.env['account.move'].search([
                ('move_type', '=', 'in_invoice'),
                ('state', '=', 'posted'),
                ('invoice_date', '>=', reporte.fecha_inicio),
                ('invoice_date', '<=', reporte.fecha_fin),
            ])

            examenes = self.env['taekwondo.examen'].search([
                ('fecha_examen', '>=', reporte.fecha_inicio),
                ('fecha_examen', '<=', reporte.fecha_fin),
            ])
            costos_operativos_examen = sum(
                examen.costo_sinodal + examen.costo_institucion + examen.costo_tabla + examen.costo_cinta
                + sum(examen.aditamentos_ids.mapped('costo'))
                for examen in examenes
            )

            torneos = self.env['taekwondo.torneo_participacion'].search([
                ('fecha', '>=', reporte.fecha_inicio),
                ('fecha', '<=', reporte.fecha_fin),
            ])
            ganancia_torneos = sum(torneos.mapped('ganancia'))

            ingresos_totales = sum(facturas.mapped('amount_total'))
            gastos_totales = sum(gastos.mapped('amount_total'))
            utilidad_neta = (
                ingresos_totales - gastos_totales - costos_operativos_examen
                - reporte.gasto_fijo_mensual + ganancia_torneos
            )
            parte_socio = utilidad_neta * (reporte.porcentaje_socio / 100)

            parte_propia = utilidad_neta - parte_socio

            retiros_propio = self.env['taekwondo.retiro_socio'].search([
                ('quien', '=', 'propio'),
                ('fecha', '>=', reporte.fecha_inicio),
                ('fecha', '<=', reporte.fecha_fin),
            ])
            retiros_socio = self.env['taekwondo.retiro_socio'].search([
                ('quien', '=', 'socio'),
                ('fecha', '>=', reporte.fecha_inicio),
                ('fecha', '<=', reporte.fecha_fin),
            ])
            retiros_propio_total = sum(retiros_propio.mapped('monto'))
            retiros_socio_total = sum(retiros_socio.mapped('monto'))

            reporte.ingresos_totales = ingresos_totales
            reporte.gastos_totales = gastos_totales
            reporte.costos_operativos_examen = costos_operativos_examen
            reporte.ganancia_torneos = ganancia_torneos
            reporte.utilidad_neta = utilidad_neta
            reporte.parte_socio = parte_socio
            reporte.parte_propia = parte_propia
            reporte.retiros_propio_total = retiros_propio_total
            reporte.retiros_socio_total = retiros_socio_total
            reporte.saldo_pendiente_propio = parte_propia - retiros_propio_total
            reporte.saldo_pendiente_socio = parte_socio - retiros_socio_total
