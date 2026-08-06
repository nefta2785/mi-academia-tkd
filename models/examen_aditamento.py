from odoo import fields, models


class TaekwondoExamenAditamento(models.Model):
    _name = 'taekwondo.examen_aditamento'
    _description = 'Aditamento adicional de examen'

    examen_id = fields.Many2one(
        comodel_name='taekwondo.examen',
        string='Examen',
        required=True,
        ondelete='cascade',
    )
    concepto = fields.Char(string='Concepto', required=True)
    costo = fields.Float(string='Costo', required=True)
