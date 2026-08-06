from odoo import api, fields, models


class TaekwondoTorneoParticipacion(models.Model):
    _name = 'taekwondo.torneo_participacion'
    _description = 'Participación en torneo'

    alumno_id = fields.Many2one(comodel_name='taekwondo.alumno', string='Alumno', required=True)
    nombre_torneo = fields.Char(string='Nombre del torneo', required=True)
    fecha = fields.Date(required=True, default=fields.Date.context_today)
    costo = fields.Float(string='Costo (inscripción/gastos)', default=0.0)
    precio = fields.Float(string='Cobrado al alumno', default=0.0)
    ganancia = fields.Float(string='Ganancia', compute='_compute_ganancia', store=True)

    @api.depends('costo', 'precio')
    def _compute_ganancia(self):
        for torneo in self:
            torneo.ganancia = torneo.precio - torneo.costo
