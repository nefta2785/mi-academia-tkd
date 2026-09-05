from odoo import api, fields, models


class TaekwondoDashboard(models.TransientModel):
    _name = 'taekwondo.dashboard'
    _description = 'Panel de inicio'

    ingresos_mes = fields.Float(compute='_compute_dashboard', store=False, readonly=True)
    facturas_pendientes_cantidad = fields.Integer(compute='_compute_dashboard', store=False, readonly=True)
    facturas_pendientes_monto = fields.Float(compute='_compute_dashboard', store=False, readonly=True)
    utilidad_neta_mes = fields.Float(compute='_compute_dashboard', store=False, readonly=True)

    def _compute_display_name(self):
        # Este modelo no tiene un campo 'name' propio (no es un registro con
        # identidad, es solo un panel de cifras calculado al vuelo), así que
        # sin este override Odoo cae en su texto de emergencia
        # "modelo,id_temporal" para el título del formulario/breadcrumb.
        for dashboard in self:
            dashboard.display_name = 'Panel de Inicio'

    @api.depends()
    def _compute_dashboard(self):
        hoy = fields.Date.context_today(self)
        inicio_mes = hoy.replace(day=1)

        for dashboard in self:
            facturas_mes = self.env['account.move'].search([
                ('move_type', '=', 'out_invoice'),
                ('state', '=', 'posted'),
                ('invoice_date', '>=', inicio_mes),
                ('invoice_date', '<=', hoy),
            ])
            ingresos_mes = sum(facturas_mes.mapped('amount_total'))

            facturas_pendientes = self.env['account.move'].search([
                ('move_type', '=', 'out_invoice'),
                ('state', '=', 'draft'),
            ])

            gastos_mes = self.env['account.move'].search([
                ('move_type', '=', 'in_invoice'),
                ('state', '=', 'posted'),
                ('invoice_date', '>=', inicio_mes),
                ('invoice_date', '<=', hoy),
            ])
            gastos_totales_mes = sum(gastos_mes.mapped('amount_total'))

            dashboard.ingresos_mes = ingresos_mes
            dashboard.facturas_pendientes_cantidad = len(facturas_pendientes)
            dashboard.facturas_pendientes_monto = sum(facturas_pendientes.mapped('amount_total'))
            dashboard.utilidad_neta_mes = ingresos_mes - gastos_totales_mes
